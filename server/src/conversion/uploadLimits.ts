/** Match @fastify/multipart `limits.fileSize` and nginx `client_max_body_size`. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export const MAX_UPLOAD_LABEL = '2 GB';
