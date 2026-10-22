// The Worker's entry point: the app plus the Durable Object class (it must be exported from the main module). Tests import index.ts directly.
export { default } from "./index";
export { StatsCounter } from "./lib/statsCounter";
