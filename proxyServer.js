import express from 'express';
import axios from 'axios';
import rateLimit from 'express-rate-limit';
import { URL } from 'url';

const app = express();
const port = Number(process.env.PROXY_PORT);

// Rate limiting: 100 requests per 10 minutes
const limiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 600,
    message: 'Too many requests, please try again later.',
});


// due to using CDN it will create bugs, because CDN IPs are same for all users
// app.use(limiter);

const ALLOWED_DOMAINS = process.env.PROXY_ALLOWED_URLS.split(","); // Add your allowed domains here

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes

// Logging middleware
app.use((req, res, next) => {
    const startTime = Date.now();
    const { ip, method, originalUrl } = req;

    console.log(`[${new Date().toISOString()}] ${ip} - ${method} ${originalUrl}`);

    res.on('finish', () => {
        const duration = Date.now() - startTime;
        console.log(`[${new Date().toISOString()}] ${ip} - ${method} ${originalUrl} - ${res.statusCode} (${duration}ms)`);
    });

    next();
});


app.get(`/${process.env.PROXY_PATH}`, async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        console.error('URL parameter is missing');
        return res.status(400).send('URL parameter is required');
    }

    let targetDomain;
    try {
        const urlObj = new URL(targetUrl);
        targetDomain = urlObj.hostname;
    } catch (error) {
        console.error('Invalid URL:', targetUrl);
        return res.status(400).send('Invalid URL');
    }

    // Check if the target domain is allowed
    const isAllowed = ALLOWED_DOMAINS.some((domain) => targetDomain === domain || targetDomain.endsWith(`.${domain}`));
    if (!isAllowed) {
        console.error(`Access denied for domain: ${targetDomain}`);
        return res.status(403).send('Access to the specified domain is not allowed');
    }

    try {
        const response = await axios({
            method: 'get',
            url: targetUrl,
            responseType: 'arraybuffer', // Download the file as a binary buffer
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 400,
            timeout: 30000, // 30 seconds
        });

        // Check if the final redirected URL is allowed
        const finalUrl = response.request.res.responseUrl || targetUrl;
        const finalUrlObj = new URL(finalUrl);
        const finalHostname = finalUrlObj.hostname;

        const isFinalAllowed = ALLOWED_DOMAINS.some((domain) => finalHostname === domain || finalHostname.endsWith(`.${domain}`));

        if (!isFinalAllowed) {
            console.error(`Access denied for redirected hostname: ${finalHostname}`);
            return res.status(403).send('Access to the redirected domain is not allowed');
        }


        // Check the file size
        const fileSize = response.data.length;
        if (fileSize > MAX_FILE_SIZE) {
            console.error(`File size exceeds limit: ${fileSize} bytes`);
            return res.status(413).send('File size exceeds the allowed limit of 10MB');
        }

        res.set('Content-Type', response.headers['content-type']);

        res.send(response.data);
    } catch (error) {
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            stack: error.stack,
            config: error.config, // Axios request configuration
        });
        console.error('Error fetching the resource:', error.message);
        res.status(500).send('Error fetching the resource');
    }
});

app.listen(port, () => {
    console.log(`Proxy server is running on http://127.0.0.1:${port}`);
    return "0.0.0.0"
});