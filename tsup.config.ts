import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/exact.ts", "src/envelope.ts"],
  format: ["esm"],
  dts: true,
  splitting: true,
  clean: true,
  outDir: "dist",
  target: "es2022",
});
