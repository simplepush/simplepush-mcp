import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/http.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node20",
  outputOptions: {
    banner: "#!/usr/bin/env node",
  },
});
