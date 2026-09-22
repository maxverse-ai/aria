import type { EnginePlugin } from '../plugin/types';
import type { EngineRuntimeFactory } from '../runtime/construction';
import { claudeEnginePlugin, claudeRuntimeFactory } from './claude/plugin';
import { codexEnginePlugin, codexRuntimeFactory } from './codex/plugin';
import { devinEnginePlugin, devinRuntimeFactory } from './devin/plugin';
import { dshEnginePlugin, dshRuntimeFactory } from './dsh/plugin';
import { grokEnginePlugin, grokRuntimeFactory } from './grok/plugin';
import { kimiEnginePlugin, kimiRuntimeFactory } from './kimi/plugin';
import { mimoEnginePlugin, mimoRuntimeFactory } from './mimo/plugin';
import { opencodeEnginePlugin, opencodeRuntimeFactory } from './opencode/plugin';
import { piEnginePlugin, piRuntimeFactory } from './pi/plugin';

const factories = new Map<EnginePlugin, EngineRuntimeFactory>([
  [claudeEnginePlugin, claudeRuntimeFactory],
  [codexEnginePlugin, codexRuntimeFactory],
  [devinEnginePlugin, devinRuntimeFactory],
  [grokEnginePlugin, grokRuntimeFactory],
  [opencodeEnginePlugin, opencodeRuntimeFactory],
  [dshEnginePlugin, dshRuntimeFactory],
  [kimiEnginePlugin, kimiRuntimeFactory],
  [mimoEnginePlugin, mimoRuntimeFactory],
  [piEnginePlugin, piRuntimeFactory],
]);

/** Built-in engine plugins, registered by the plugin registry on first use. */
export const BUILTIN_ENGINE_PLUGINS: readonly EnginePlugin[] = [...factories.keys()];

/** Object identity keeps external v1 plugins on their compatibility path. */
export function getBuiltinEngineRuntimeFactory(plugin: EnginePlugin): EngineRuntimeFactory | undefined {
  return factories.get(plugin);
}
