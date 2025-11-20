import express from "express";
import cors from "cors";
import winston from "winston";
import path from "path";
import { fileURLToPath } from "url";

import { getCinemeta } from "./utils.js";
import { errorHandler } from "./errorMiddleware.js";
import Digimovie from "./sources/digimovie.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure Logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.colorize(),
    winston.format.printf(
      ({ level, message, timestamp }) => `[${timestamp}] ${level}: ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

const addon = express();
addon.use(cors());
addon.use(express.json());
addon.use(errorHandler);

const PORT = process.env.PORT || 7001;

function parseConfig(configStr) {
  try {
    if (!configStr) return null;
    const decoded = Buffer.from(configStr, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch (e) {
    logger.error(`Error parsing config: ${e.message}`);
    return null;
  }
}

// --- تغییر مهم: نرمال‌سازی پیشرفته ---
function normalizeTitle(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/&/g, "and") // تبدیل & به and
    .replace(/^the\s+/i, "") // حذف the از اول جمله
    .replace(/^a\s+/i, "") // حذف a از اول جمله
    .replace(/^an\s+/i, "") // حذف an از اول جمله
    .replace(/[:\-\.]/g, " ") // حذف علائم نگارشی
    .replace(/\s+/g, " ") // حذف فاصله‌های اضافه
    .trim();
}

addon.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "config_page.html"));
});

addon.post("/validate", async (req, res) => {
  logger.debug("Validation request received.");
  const { digiUser, digiPass } = req.body;

  if (!digiUser || !digiPass) {
    return res.status(400).json({
      success: false,
      message: "نام کاربری و رمز عبور الزامی است.",
    });
  }

  const digi = new Digimovie(
    process.env.DIGIMOVIE_BASEURL,
    logger,
    digiUser,
    digiPass
  );

  try {
    const loginResult = await digi.login();
    if (loginResult === true) {
      return res.json({ success: true });
    } else {
      return res.json({
        success: false,
        message: "نام کاربری یا رمز عبور اشتباه است.",
      });
    }
  } catch (e) {
    logger.error(`Validation error: ${e.message}`);
    return res.status(500).json({
      success: false,
      message: "خطای داخلی سرور.",
    });
  }
});

addon.get("/:config?/configure", (req, res) => {
  res.sendFile(path.join(__dirname, "config_page.html"));
});

addon.get("/:config?/manifest.json", function (req, res) {
  const config = parseConfig(req.params.config);
  const description = config
    ? "حساب کاربری شما با موفقیت متصل شد."
    : "دسترسی به آرشیو فیلم و سریال دیجی‌موویز. برای اتصال حساب اشتراکی خود، دکمه پیکربندی را انتخاب کنید.";
  const manifest = {
    id: "com.example.digimoviez",
    version: "1.0.0",
    name: "DigiMoviez",
    description: description,
    logo: "https://raw.githubusercontent.com/younessaeedian/stremio-digimovie-addon/refs/heads/main/logo.png",
    catalogs: [],
    resources: [
      {
        name: "stream",
        types: ["series", "movie"],
        idPrefixes: ["tt"],
      },
    ],
    types: ["movie", "series"],
    behaviorHints: {
      configurable: true,
      configurationRequired: !config,
    },
  };
  res.send(manifest);
});

// --- هندلر استریم ---
addon.get("/:config/stream/:type/:id.json", async function (req, res) {
  const { type, id, config } = req.params;
  logger.debug(`Received stream request for: ${type} ${id}`);

  const userConfig = parseConfig(config);

  if (!userConfig || !userConfig.digiUser || !userConfig.digiPass) {
    return res.send({
      streams: [{ title: "⚠️ لطفاً ابتدا تنظیمات را انجام دهید", url: "" }],
    });
  }

  const imdbIdRaw = id.split(":")[0];

  try {
    const metaData = await getCinemeta(type, imdbIdRaw);
    if (!metaData?.meta?.name) {
      logger.warn(`Cinemeta metadata not found for ID: ${imdbIdRaw}`);
      return res.send({ streams: [] });
    }

    const originalTitle = metaData.meta.name;

    // حذف سال برای جستجو
    const searchTitle = originalTitle.replace(/\s*\(\d{4}\).*$/, "").trim();
    // نرمال‌سازی برای مقایسه (حذف The و ...)
    const normalizedSearchTitle = normalizeTitle(searchTitle);

    logger.info(
      `Target: "${searchTitle}" (Norm: "${normalizedSearchTitle}") [${type}]`
    );

    let allStreams = [];

    const digi = new Digimovie(
      process.env.DIGIMOVIE_BASEURL,
      logger,
      userConfig.digiUser,
      userConfig.digiPass
    );

    try {
      const loggedIn = await digi.login();
      if (!loggedIn) {
        return res.send({
          streams: [
            { title: "❌ خطا در ورود (اطلاعات اکانت را بررسی کنید)", url: "" },
          ],
        });
      }

      const searchResults = await digi.search(searchTitle);
      logger.debug(`Found ${searchResults.length} potential matches.`);

      if (searchResults && searchResults.length > 0) {
        // --- Scoring System ---
        const scoredResults = searchResults.map((item) => {
          let score = 0;

          // نرمال‌سازی نام آیتم پیدا شده
          const normalizedItemName = normalizeTitle(item.name);

          // 1. Type Match (Critical)
          if (item.type === type) {
            score += 100;
          } else {
            score -= 50;
          }

          // 2. Name Match
          if (normalizedItemName === normalizedSearchTitle) {
            score += 60; // Exact match (ignoring "The", "&", etc.)
          } else if (normalizedItemName.startsWith(normalizedSearchTitle)) {
            score += 20; // Starts with
          } else if (normalizedItemName.includes(normalizedSearchTitle)) {
            score += 10; // Includes
          }

          // دیباگ برای دیدن امتیازدهی
          // logger.debug(`Scoring "${item.name}" -> Norm: "${normalizedItemName}" = ${score}`);

          return { ...item, score };
        });

        // Sort by score
        scoredResults.sort((a, b) => b.score - a.score);

        const bestMatch = scoredResults[0];

        logger.info(`Winner: "${bestMatch.name}" (Score: ${bestMatch.score})`);

        if (bestMatch.score > 0) {
          const movieDetails = await digi.getMovieData(type, bestMatch.id);

          if (movieDetails) {
            const links = digi.getLinks(type, id, movieDetails);
            links.forEach((link) => {
              link.title = `[DigiMovie] ${link.title || "لینک پخش"}`;

              if (
                process.env.PROXY_ENABLE === "true" ||
                process.env.PROXY_ENABLE === "1"
              ) {
                link.url = `${process.env.PROXY_URL}/${
                  process.env.PROXY_PATH
                }?url=${encodeURIComponent(link.url)}`;
              }
            });
            allStreams.push(...links);
          }
        } else {
          logger.warn(`No good match found. Best score was ${bestMatch.score}`);
        }
      } else {
        logger.info(`No results found in provider for: "${searchTitle}"`);
      }
    } catch (err) {
      logger.error(`Error processing stream provider: ${err.message}`);
    }

    return res.send({ streams: allStreams });
  } catch (e) {
    logger.error(`Unexpected stream error: ${e.message}`);
    res.send({ streams: [] });
  }
});

addon.get("/health", (req, res) => res.send("OK"));

addon.listen(PORT, function () {
  logger.info("---------------------------------------------------");
  logger.info(`Server running on port ${PORT}`);
  logger.info("---------------------------------------------------");
});
