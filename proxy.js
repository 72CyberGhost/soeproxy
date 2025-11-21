// include dependencies
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const FormData = require('form-data');
const { createProxyMiddleware,fixRequestBody } = require('http-proxy-middleware');
const fs = require('fs');
const https = require('https');
const { emitWarning } = require('process');
const winston = require("winston");

const app = express();

// configure multer for parsing multipart/form-data
const upload = multer();

// cloud foundry provides VCAP_APPLICATION env var — run HTTP there using provided PORT
const isCloudFoundry = !!process.env.VCAP_APPLICATION;

const doxSchemaName = process.env.DOX_SCHEMA || "SO_Auto_Extraction_Schema";


const simpleRequestLogger = (proxyServer, options) => {
  proxyServer.on('proxyReq', (proxyReq, req, res) => {
    logger.info(`[HPM] [${req.method}] ${req.url}`); // outputs: [HPM] GET /users
  });
};

// Function to handle proxy request modifications
var onProxyReq = function(proxyReq, req, res) {
  try {
    const contentType = req.get('Content-Type') || '';
    if (req.method === 'POST' && contentType.includes('multipart/form-data')) {
      logger.debug('Handling multipart/form-data request ...');
      // Build a FormData instance from multer-parsed fields/files
      const form = new FormData();
      logger.debug('Modification of body request ...');
      for (const key in req.body) {
        if (Object.prototype.hasOwnProperty.call(req.body, key)) {
          const jsonOptions = JSON.parse(req.body[key]);
          logger.debug('Original body request: ' + JSON.stringify(jsonOptions));

          jsonOptions.schemaName = doxSchemaName;
          delete jsonOptions.extraction;
          logger.debug('Modified body request: ' + JSON.stringify(jsonOptions));
          form.append(key, JSON.stringify(jsonOptions));
        }
      }
      logger.debug('Adding files to multipart request ...');
      if (Array.isArray(req.files)) {
        req.files.forEach(file => {
          // use buffer (multer memory storage) and preserve filename and mimetype
          form.append(file.fieldname, file.buffer, { filename: file.originalname, contentType: file.mimetype });
        });
      }

      // Set multipart headers (including boundary)
      logger.debug('Adding headers to request ...');
      const headers = form.getHeaders();
      Object.keys(headers).forEach(header => proxyReq.setHeader(header, headers[header]));

      // Try to set Content-Length to avoid chunked transfer if possible
      logger.debug('Calculating Content-Length for the request ...');
      try {
        const length = form.getLengthSync();
        if (length && !Number.isNaN(length)) {
          proxyReq.setHeader('Content-Length', length);
        }
      } catch (e) {
        // fall back to chunked encoding
      }

      // Pipe the form to the proxy request. Do not use fixRequestBody for multipart.
      logger.debug('Pipelining new request ...');
      form.pipe(proxyReq);
      form.on('error', err => {
        console.error('Form pipe error:', err);
        try { proxyReq.destroy(err); } catch (e) {}
      });
      form.on('end', () => {
        try { proxyReq.end(); } catch (e) {}
      });
    } else {
      // non-multipart bodies can be handled by helper
      logger.debug('No multipart/form-data request, using fixRequestBody ...');
      fixRequestBody(proxyReq, req);
    }
  } catch (err) {
    logger.error(`Error in onProxyReq: ${err}`);
  }
};

// Function to handle proxy response modifications (if needed)
var onProxyRes = async function (proxyRes, req, res) {
  // Pipe proxy response to client and forward stream errors
  proxyRes.pipe(res);
  proxyRes.on('error', err => {
    console.error('proxyRes stream error:', err);
    try { res.destroy(err); } catch (e) {}
  });
};

const doxForward = createProxyMiddleware({
  target: 'https://aiservices-dox.cfapps.eu10.hana.ondemand.com', // target host with the same base path
  changeOrigin: true, // needed for virtual hosted sites
  //selfHandleResponse: true, // allow response body manipulation
  plugins: [simpleRequestLogger],
  on: {
    proxyReq: onProxyReq,
    //proxyRes: onProxyRes,
  },
});

// Define logging facilities
const standardFormat = winston.format.printf(({level, message, label, timestamp}) => `${timestamp} ${label || '-'} ${level}: ${message}`);
var logger;
// if cloud foundry, log to console only; else also log to file
  if (isCloudFoundry) { 
    logger = winston.createLogger({
        level: "debug",
        format: winston.format.combine(
              winston.format.timestamp({format: 'YYYY-MM-DD HH:mm:ss.SSS'}),
        ),
        transports: [
            new winston.transports.Console(
                  { format: standardFormat
                  })
        ]
    });
  } else {
    logger = winston.createLogger({
       level: "debug",
       format: winston.format.combine(
            winston.format.timestamp({format: 'YYYY-MM-DD HH:mm:ss.SSS'}),
       ),
       transports: [
           new winston.transports.Console(
                { format: standardFormat
                }),
           new winston.transports.File({ 
            filename: "log/soeproxy.log",
            format: standardFormat
           })
       ]
   });
  };
 
logger.info('Starting Sale Order Extraction Proxy ...');
logger.debug('Setting body parser limits ...');
app.use(bodyParser.json({limit: 52428800}));
app.use(bodyParser.urlencoded({limit: 52428800, extended: true, parameterLimit:52428800}));

logger.debug('Connecting proxy middleware function for request manipulation and formward request to DOX ...');
// Use multer middleware to parse multipart/form-data before proxying
app.use('/', upload.any(),doxForward);

logger.debug('Determining runtime environment for HTTP/HTTPS startup...');

// Allow overriding SSL paths and passphrase via env vars for flexibility
const sslKeyPath = process.env.SSL_KEY || 'certs/lab02.key';
const sslCertPath = process.env.SSL_CERT || 'certs/lab02.pem';
const sslPassphrase = process.env.SSL_PASSPHRASE || 'password';

// Start server based on environment
if (isCloudFoundry) {
  const port = process.env.PORT || 8080;
  logger.info(`Detected Cloud Foundry environment — starting HTTP on port ${port}`);
  app.listen(port, () => {
    logger.info(`HTTP server listening on port ${port}`);
  });
} else {
  // try to start HTTPS locally; if certs missing, fall back to HTTP on port 8080
  try {
    logger.info('Starting local HTTPS server');
    const sslOptions = {
      key: fs.readFileSync(sslKeyPath),
      cert: fs.readFileSync(sslCertPath),
      passphrase: sslPassphrase
    };
    https.createServer(sslOptions, app).listen(443, () => {
      logger.info('HTTPS server listening on port 443');
    });
  } catch (err) {
    logger.warn(`Failed to start HTTPS on port 443 (${err.message}). Falling back to HTTP on port 8080.`);
    const port = process.env.PORT || 8080;
    app.listen(port, () => {
      logger.info(`HTTP server listening on port ${port}`);
    });
  }
}

