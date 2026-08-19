"""CLI worker — JSONL events on stdout for the desktop host."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from modelcraft_engine.hw import plan_training, probe, to_jsonable
from modelcraft_engine.train import run_training


def emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="modelcraft-worker")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("probe", help="Print hardware snapshot as JSON")

    p_plan = sub.add_parser("plan", help="Print adaptive training plan")
    p_plan.add_argument("--model", required=True)
    p_plan.add_argument("--mode", default="balanced")
    p_plan.add_argument("--material-bytes", type=int, default=0)
    p_plan.add_argument("--trainable", action="store_true", default=True)
    p_plan.add_argument("--not-trainable", action="store_true")

    p_train = sub.add_parser("train", help="Run training from JSON config file")
    p_train.add_argument("--config", required=True)

    args = parser.parse_args(argv)

    if args.cmd == "probe":
        emit({"type": "hw", **to_jsonable(probe())})
        return 0

    if args.cmd == "plan":
        trainable = not args.not_trainable
        plan = plan_training(
            model_path=args.model,
            power_mode=args.mode,
            material_bytes=args.material_bytes,
            trainable=trainable,
        )
        emit({"type": "plan", **to_jsonable(plan)})
        return 0

    if args.cmd == "train":
        with open(args.config, encoding="utf-8-sig") as f:
            config = json.load(f)
        result = run_training(config, emit)
        return 0 if result.get("ok") else 2

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
