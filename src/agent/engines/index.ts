import type { EnginePlugin } from '../plugin/types';
import { claudeEnginePlugin } from './claude/plugin';
import { codexEnginePlugin } from './codex/plugin';
import { dshEnginePlugin } from './dsh/plugin';
import { grokEnginePlugin } from './grok/plugin';
import { kimiEnginePlugin } from './kimi/plugin';
import { opencodeEnginePlugin } from './opencode/plugin';
import { piEnginePlugin } from './pi/plugin';

/** Built-in engine plugins, registered by the plugin registry on first use. */
export const BUILTIN_ENGINE_PLUGINS: readonly EnginePlugin[] = [
  claudeEnginePlugin,
  codexEnginePlugin,
  grokEnginePlugin,
  opencodeEnginePlugin,
  dshEnginePlugin,
  kimiEnginePlugin,
  piEnginePlugin,
];
