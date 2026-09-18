FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html scripts.js style.css /usr/share/nginx/html/
COPY img/ /usr/share/nginx/html/img/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1/health || exit 1