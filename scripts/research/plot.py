# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""Standalone figures from frozen JSON summaries; run with uv run scripts/research/plot.py."""
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams.update({"svg.hashsalt": "folio-v101", "font.size": 10})
root = Path(sys.argv[1] if len(sys.argv) > 1 else "results")
crossover = json.loads((root / "execution/crossover/summary.json").read_text())["groups"]
fig, axes = plt.subplots(1, 2, figsize=(11, 4), layout="constrained")
for ax, family in zip(axes, ["compute", "stream"]):
    cells = [(json.loads(key), value) for key, value in crossover.items() if json.loads(key)["kind"] == family]
    x = [cell["rounds" if family == "compute" else "count"] for cell, _ in cells]
    for arm in ["auto-2", "auto-4", "auto-8", "tracked-4", "manual-8"]:
        y = [value[arm]["pairedSpeedup"]["median"] for _, value in cells]
        bounds = [value[arm]["pairedSpeedup"]["medianCi95"] for _, value in cells]
        ax.errorbar(x, y, yerr=[[max(0, a - b[0]) for a, b in zip(y, bounds)],
                              [max(0, b[1] - a) for a, b in zip(y, bounds)]], marker="o", label=arm, capsize=2)
    ax.axhline(1, color="black", linewidth=.7, linestyle="--")
    ax.set(xscale="log", yscale="log", xlabel="Rounds per element" if family == "compute" else "Elements",
           ylabel="Native / arm elapsed time", title=family.capitalize())
    ax.grid(alpha=.2)
axes[0].legend(fontsize=8)
fig.suptitle("Automatic, tracked and manual execution · 9 paired rounds · 95% within-run bootstrap intervals")
fig.savefig(root / "execution/crossover/crossover.svg", metadata={"Date": None})
plt.close(fig)

contexts = json.loads((root / "corpus/contexts/summary.json").read_text())["groups"]
pages = json.loads((root / "corpus/page-reset/summary.json").read_text())["groups"]
names = list(contexts)
fig, ax = plt.subplots(figsize=(11, 7), layout="constrained")
y = list(range(len(names)))
for offset, groups, arm, label in [(-.22, contexts, "tasks-8-batched", "Folio tasks · full reset"),
                                 (0, pages, "tasks-8-batched", "Folio tasks · changed-page reset"),
                                 (.22, pages, "ordinary-8-batched", "Conventional workers · changed-page reset")]:
    values = [groups[name][arm]["pairedSpeedup"]["median"] for name in names]
    ax.barh([index + offset for index in y], values, height=.21, label=label)
ax.axvline(1, color="black", linewidth=.7, linestyle="--")
ax.set(yticks=y, yticklabels=names, xlabel="Matched native / arm elapsed time", title="Independent operations on eight workers · 7 paired rounds")
ax.invert_yaxis()
ax.legend(fontsize=8)
ax.grid(axis="x", alpha=.2)
fig.savefig(root / "corpus/page-reset/contexts.svg", metadata={"Date": None})
plt.close(fig)
