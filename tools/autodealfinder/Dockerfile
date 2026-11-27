FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ADF_DATA=/data TZ=Europe/Tallinn
WORKDIR /app
COPY adf.py config.json ./
USER nobody
CMD ["python", "adf.py"]
