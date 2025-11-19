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

// Configure Logger (Logs remain in English for better debugging)
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

// Helper: Parse Config from Base64
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

// 1. Root Route (Config Page)
addon.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "config_page.html"));
});

// 2. Validation API (Check Credentials)
addon.post("/validate", async (req, res) => {
  logger.debug("Validation request received.");

  const { digiUser, digiPass } = req.body;

  if (!digiUser || !digiPass) {
    logger.warn("Validation failed: Missing username or password.");
    // User-facing error (Persian)
    return res.status(400).json({
      success: false,
      message: "نام کاربری و رمز عبور الزامی است.",
    });
  }

  logger.debug(`Attempting validation for user: ${digiUser}`);

  const digi = new Digimovie(
    process.env.DIGIMOVIE_BASEURL,
    logger,
    digiUser,
    digiPass
  );

  try {
    const loginResult = await digi.login();

    if (loginResult === true) {
      logger.info(`Validation successful for user: ${digiUser}`);
      return res.json({ success: true });
    } else {
      logger.warn(
        `Validation failed for user: ${digiUser} (Invalid credentials)`
      );
      // User-facing error (Persian)
      return res.json({
        success: false,
        message: "نام کاربری یا رمز عبور اشتباه است.",
      });
    }
  } catch (e) {
    logger.error(`Unexpected error during validation: ${e.message}`);
    // User-facing error (Persian)
    return res.status(500).json({
      success: false,
      message: "خطای داخلی سرور.",
    });
  }
});

// 3. Configure Redirect
addon.get("/:config?/configure", (req, res) => {
  res.sendFile(path.join(__dirname, "config_page.html"));
});

// 4. Manifest Generation
addon.get("/:config?/manifest.json", function (req, res) {
  const config = parseConfig(req.params.config);

  // User-facing description (Persian)
  const description = config
    ? "این افزونه با حساب کاربری شخصی شما تنظیم شده است."
    : "دسترسی مستقیم به آرشیو دیجی‌مووی در Stremio. برای استفاده از این افزونه نیاز به اشتراک دارید. لطفاً برای تنظیم حساب کاربری دکمه Configure را بزنید.";

  const manifest = {
    id: "com.example.digimovie",
    version: "1.0.0",
    name: "DigiMovie",
    description: description,
    logo: "https://raw.githubusercontent.com/MrMohebi/stremio-ir-providers/refs/heads/master/logo.png",
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

// 5. Stream Handler
addon.get("/:config/stream/:type/:id.json", async function (req, res) {
  const { type, id, config } = req.params;
  logger.debug(`Received stream request for: ${type} ${id}`);

  const userConfig = parseConfig(config);

  if (!userConfig || !userConfig.digiUser || !userConfig.digiPass) {
    logger.warn("Stream request failed: Missing or invalid configuration.");
    // User-facing stream error (Persian)
    return res.send({
      streams: [
        {
          title: "⚠️ لطفاً ابتدا تنظیمات را انجام دهید (دکمه Configure)",
          url: "",
        },
      ],
    });
  }

  const imdbIdRaw = id.split(":")[0];

  try {
    const metaData = await getCinemeta(type, imdbIdRaw);
    if (!metaData?.meta?.name) {
      logger.warn(`Cinemeta metadata not found for ID: ${imdbIdRaw}`);
      return res.send({ streams: [] });
    }

    const title = metaData.meta.name;
    logger.info(`Searching provider for title: "${title}"`);

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
        logger.error("Provider login failed during stream request.");
        // User-facing stream error (Persian)
        return res.send({
          streams: [
            { title: "❌ خطا در ورود (اطلاعات اکانت را بررسی کنید)", url: "" },
          ],
        });
      }

      const searchResults = await digi.search(title);
      logger.debug(`Search results found: ${searchResults.length}`);

      if (searchResults && searchResults.length > 0) {
        const match = searchResults[0];
        const movieDetails = await digi.getMovieData(type, match.id);

        if (movieDetails) {
          const links = digi.getLinks(type, id, movieDetails);
          links.forEach((link) => {
            // Translation for "Link" or "Stream" if title is missing
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
        logger.info(`No results found in provider for: "${title}"`);
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

// Health Check
addon.get("/health", (req, res) => res.send("OK"));

// Start Server
addon.listen(PORT, function () {
  logger.info("---------------------------------------------------");
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Access manifest at: http://127.0.0.1:${PORT}/manifest.json`);
  logger.info("---------------------------------------------------");
});
