import { readFileSync } from 'node:fs';
import type { AppConfig } from './schema.js';
import { AppConfigSchema } from './schema.js';

export type {
  AppConfig,
  CoinGeckoConfig,
  CoinGlassConfig,
  DataQualityConfig,
  FactorsConfig,
  ProvidersConfig,
  RegimeConfig,
  RegimeWeightingConfig,
  ReportConfig,
  SoSoValueConfig,
  UniverseConfig,
} from './schema.js';
export { AppConfigSchema } from './schema.js';

/** Plain JSON-serializable equivalent of `AppConfig` — the shape the pipeline consumes. */
export type AppConfigDict = AppConfig;

/**
 * Load and strictly validate a config file. Equivalent to `config.py::load_config`.
 * Throws a `ZodError` (mirrors pydantic's `ValidationError`) on unknown keys or bad types.
 */
export function loadConfig(path: string): AppConfig {
  const raw = readFileSync(path, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return AppConfigSchema.parse(parsed);
}

/** Equivalent to `AppConfig.to_runtime_dict()`: a plain, JSON-serializable dict. */
export function toRuntimeDict(config: AppConfig): AppConfigDict {
  return JSON.parse(JSON.stringify(config)) as AppConfigDict;
}

/** Equivalent to `config.py::load_config_dict`. */
export function loadConfigDict(path: string): AppConfigDict {
  return toRuntimeDict(loadConfig(path));
}
