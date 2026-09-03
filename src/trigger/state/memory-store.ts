import { AbstractTriggerStateStore, EMPTY_TRIGGER_STATE, type TriggerStateSnapshot } from './core-store';

export class InMemoryTriggerStateStore extends AbstractTriggerStateStore {
  private readonly state: TriggerStateSnapshot = structuredClone(EMPTY_TRIGGER_STATE);

  protected override async read<T>(select: (state: TriggerStateSnapshot) => T): Promise<T> {
    return structuredClone(select(this.state));
  }

  protected override async mutate<T>(update: (state: TriggerStateSnapshot) => T): Promise<T> {
    return structuredClone(update(this.state));
  }
}
