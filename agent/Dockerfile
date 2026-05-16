FROM python:3.12-slim

WORKDIR /app

# セキュリティパッチ適用
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# AgentCore SDK はポート 8080 で HTTPS リッスン
EXPOSE 8080

CMD ["opentelemetry-instrument", "python", "agent.py"]
