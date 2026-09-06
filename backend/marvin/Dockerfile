FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir torch==2.6.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt
COPY app.py request_queue.py telemetry.py modeling_qwen3.py LICENSE ./

ENV MODEL_NAME=dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1
ENV PORT=7860
ENV OMP_NUM_THREADS=2 MKL_NUM_THREADS=2
EXPOSE 7860
CMD ["python", "app.py"]
