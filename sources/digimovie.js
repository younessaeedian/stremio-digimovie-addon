import Source from "./source.js";
import Axios from "axios";
import { logAxiosError, searchAndGetTMDB } from "../utils.js";

export default class Digimovie extends Source {
  // مقادیر پیش‌فرض را خالی می‌گذاریم
  username = "";
  password = "";

  token = "";
  refreshToken = "";

  // تغییر مهم: دریافت username و password در زمان ساخت کلاس
  constructor(baseURL, logger, username, password) {
    super(baseURL, logger);
    this.providerID = "digimovie" + this.idSeparator;

    // اینجا مقادیر دریافتی از فرم را جایگزین می‌کنیم
    this.username = username;
    this.password = password;
  }

  async isLogin() {
    // اگر توکن نداریم یعنی لاگین نیستیم
    if (!this.token) return false;

    try {
      const res = await Axios.request({
        url: `https://${this.baseURL}/api/app/v1/get_profile`,
        method: "post",
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          "Content-Type": "application/json",
          authorization: this.token,
        },
      });
      if (res.data?.status) {
        this.logger.debug(`Digimovie was logged in with token: ${this.token}`);
        return true;
      }
    } catch (e) {}
    this.logger.info(`Digimovie is NOT logged in`);
    return false;
  }

  async login() {
    // اگر یوزر یا پسورد خالی باشد، اصلاً تلاش نکن
    if (!this.username || !this.password) {
      this.logger.error(
        "Digimovie login failed: Username or Password is missing."
      );
      return false;
    }

    const isLogin = await this.isLogin();
    if (isLogin) {
      this.logger.debug(`Digimovie was logged in with token: ${this.token}`);
      return true;
    }

    try {
      const res = await Axios.request({
        url: `https://${this.baseURL}/api/app/v1/login`,
        method: "post",
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
        data: {
          username: this.username, // استفاده از یوزری که از فرم آمده
          password: this.password, // استفاده از پسوردی که از فرم آمده
        },
        headers: {
          "Content-Type": "application/json",
        },
      });
      if (res.data?.status) {
        this.token = res.data.auth_token;
        this.refreshToken = res.data.refresh_token;
        this.logger.info(
          `Digimovie now is logged in with token: ${this.token}`
        );
        return true;
      }
    } catch (e) {
      logAxiosError(e, this.logger, "Digimovie login error: ");
    }
    return false;
  }

  async search(text) {
    try {
      this.logger.debug(`Digimovie searching for ${text}`);
      const res = await Axios.request({
        url: `https://${this.baseURL}/api/app/v1/adv_search_movies`,
        method: "post",
        data: {
          adv_s: text,
          adv_movie_type: "all",
          adv_director: "",
          adv_cast: "",
          adv_release_year: {
            min: null,
            max: null,
          },
          adv_imdb_rate: {
            min: null,
            max: null,
          },
          adv_country: "0",
          adv_age: "0",
          adv_genre: "0",
          adv_quality: "0",
          adv_network: "0",
          adv_order: "publish_date",
          adv_dubbed: "0",
          adv_censorship: "0",
          adv_subtitle: "0",
          adv_online: "0",
          per_page: 30,
          paged: 1,
        },
        headers: {
          "Content-Type": "application/json",
        },
      });
      if (!!res) {
        const items = [];

        if (res.data?.result.total_items < 1) {
          return items;
        }

        for (const item of res.data.result.items) {
          const movie = {
            name: item.title_en,
            poster: item.image_url,
            type: item.type === "movie" ? "movie" : "series",
            id: item.id,
            genres: [],
          };
          items.push(movie);
        }
        return items;
      }
    } catch (e) {
      logAxiosError(e, this.logger, "Digimovie search error: ");
    }

    return [];
  }

  async getMovieData(type, id) {
    try {
      this.logger.debug(`Digimovie getting movie with id ${id}`);
      const res = await Axios.request({
        url: `https://${this.baseURL}/api/app/v1/get_movie_detail`,
        method: "get",
        params: {
          movie_id: id,
        },
        headers: {
          "Content-Type": "application/json",
          authorization: this.token,
        },
      });
      if (res.data?.status) {
        return res.data;
      }
    } catch (e) {
      logAxiosError(e, this.logger, "Digimovie getMovieData error: ");
      // تلاش مجدد برای لاگین فقط در صورتی که خطا مربوط به احراز هویت باشد
      if (
        e.response &&
        (e.response.status === 401 || e.response.status === 403)
      ) {
        const relogin = await this.login();
        if (relogin) return this.getMovieData(type, id); // Retry once
      }
    }

    return null;
  }

  getMovieLinks(movieData) {
    const links = [];

    if (!movieData || !movieData.movie_download_urls) return links;

    for (const item of movieData.movie_download_urls) {
      const link = { url: "", title: "" };
      link.title = item.quality + " - ";
      link.title += item.size + " - ";
      link.title += item.encode + " - ";
      link.title += item.label;

      link.url = item.file;

      links.push(link);
    }

    return links;
  }

  getSeriesLinks(movieData, imdbId) {
    const links = [];
    try {
      // هندل کردن فرمت‌های مختلف ID
      let season = 1;
      let episode = 1;

      // فرمت tt12345:1:1
      const parts = imdbId.split(":");
      if (parts.length >= 3) {
        season = parseInt(parts[1]);
        episode = parseInt(parts[2]);
      }

      const seasonTitle = `:${season}`;

      if (movieData && movieData.serie_download_urls) {
        for (const item of movieData.serie_download_urls.filter((i) =>
          i.season_name.replace(" ", "").includes(seasonTitle)
        )) {
          const link = { url: "", title: "" };
          link.title = item.quality + " - " + item.size;
          if (item.links && item.links[episode - 1]) {
            link.url = item.links[episode - 1].movie;
            links.push(link);
          }
        }
      }
    } catch (e) {
      this.logger.debug(`error with => Digimovie, ${movieData}, ${imdbId}`);
      this.logger.error(e.message);
    }

    return links;
  }

  getLinks(type, imdbId, movieData) {
    if (type === "movie") {
      return this.getMovieLinks(movieData);
    }

    if (type === "series") {
      return this.getSeriesLinks(movieData, imdbId);
    }
    return [];
  }

  // متد imdbID معمولاً در حالت اسکرپر استفاده نمی‌شود اما بودنش ضرری ندارد
  async imdbID(movieData) {
    const tmdbData = await searchAndGetTMDB(movieData.movie_info.title_en);
    if (tmdbData) {
      return tmdbData.external_ids.imdb_id;
    }
    return null;
  }
}
