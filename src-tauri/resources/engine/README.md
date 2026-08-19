# ModelShaper Engine

Python worker that:

1. Probes hardware and builds an adaptive training plan  
2. Turns user text/documents into a training dataset  
3. Runs QLoRA/LoRA adaptation (when full train extras are installed)  
4. Exports GGUF / LoRA / Ollama Modelfile  

## CLI

```bash
python -m modelcraft_engine.worker probe
python -m modelcraft_engine.worker plan --model PATH --mode balanced --material-bytes 50000
python -m modelcraft_engine.worker train --config job.json
```

Events are printed as JSON lines on stdout for the desktop shell.
