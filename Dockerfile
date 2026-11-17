FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN useradd -r app && chown -R app /app
USER app

EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/healthz')"
CMD ["gunicorn", "-b", "0.0.0.0:8080", "-w", "2", "--threads", "4", "app:app"]
