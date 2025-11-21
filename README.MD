soeproxy README
soeproxy README

This README documents the current `proxy.js` implementation in this folder. The file `proxy.js` implements a proxy that can manipulate multipart/form-data bodies before forwarding them to a backend target and includes conditional startup behavior (HTTPS locally, HTTP on Cloud Foundry).

Overview

- Rebuilds multipart/form-data request bodies using `FormData` from `req.body` and `req.files` once multer has parsed them.
- Modifies JSON payloads found in form fields (the code parses JSON values and alters properties before re-serializing them into the multipart body).
- Copies multipart headers (including the boundary) and attempts to set `Content-Length` to avoid chunked transfer when possible.
- Uses `fixRequestBody` for non-multipart requests.

Startup behavior (local vs Cloud Foundry)

- The app detects Cloud Foundry by checking `process.env.VCAP_APPLICATION`. If present, it starts a plain HTTP server on `process.env.PORT` (default `8080`).
- When not running in Cloud Foundry, the app attempts to start an HTTPS server on port `443` using certificate files. If reading the certificates fails, it falls back to HTTP on `process.env.PORT` (or `8080`).

Environment variables

- `VCAP_APPLICATION` — Cloud Foundry injects this; presence switches the app to CF mode (HTTP).
- `SSL_KEY` — path to SSL private key file (default `certs/lab02.key`).
- `SSL_CERT` — path to SSL certificate file (default `certs/lab02.pem`).
- `SSL_PASSPHRASE` — passphrase for the SSL key (default not present in code; override via env var for security).
- `PORT` — port to listen on in CF mode or when falling back to HTTP.

How multipart manipulation works

- `multer` middleware parses incoming multipart/form-data requests and places fields in `req.body` and uploaded files in `req.files` (the proxy uses `upload.any()`).
- The proxy expects files to be available as buffers (multer memory storage). For each field, the code attempts to JSON.parse the field value and modifies properties (for example it sets `schemaName` and removes `extraction`), then appends the modified JSON string back into the multipart form.
- Files are appended using `form.append(fieldname, buffer, { filename, contentType })`.
- Headers returned from `form.getHeaders()` are copied to the proxied request so the backend receives the correct multipart boundary.

Security and operational notes

- Keep SSL private keys and passphrases secure. Prefer passing `SSL_PASSPHRASE` and SSL paths via environment variables rather than hardcoding secrets.
- When running under a process manager (pm2, systemd), ensure the process has read access to certificate files if you use HTTPS locally.

Running the proxy locally

1. Install dependencies in this folder:

```bash
npm install
```

2. Start the proxy locally (attempts HTTPS first):

```bash
export SSL_KEY=certs/lab02.key
export SSL_CERT=certs/lab02.pem
node proxy.js
```

If HTTPS cannot be started (missing certs), the process will log a warning and start HTTP on port specified by `PORT` or `8080`.

3. Cloud Foundry deployment:

When pushed to Cloud Foundry, CF injects `VCAP_APPLICATION` and a `PORT`. The app will start HTTP and listen on the provided `PORT`.


Debugging

- Logs are written using Winston to console and file (`log/soeproxy.log`). Check those logs for debug info.
- If multipart fields are not reaching the backend, ensure multer is configured to provide buffers (memory storage) or extend the code to use file paths with `fs.createReadStream`.
