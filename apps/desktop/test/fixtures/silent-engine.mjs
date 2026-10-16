// Stands in for a hung engine: reads its input, never answers, and ignores the end of its input.
process.stdin.on("data", () => undefined);
process.stdin.on("end", () => undefined);
setInterval(() => undefined, 1_000);
