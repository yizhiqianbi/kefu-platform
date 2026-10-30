ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

ARG PIP_INDEX_URL=https://pypi.org/simple
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -i "${PIP_INDEX_URL}" -r requirements.txt
COPY . .

ENV MUXU_DATA_DIR=/data PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8770
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8770", "--workers", "1"]
