import type {
  MemoryFormationInput,
  MemoryModelPort,
} from "../domain/memory.js";

export type MemoryScript =
  | unknown
  | ((input: MemoryFormationInput) => unknown | Promise<unknown>);

export class ScriptedMemoryModel implements MemoryModelPort {
  readonly requests: MemoryFormationInput[] = [];
  private readonly scripts: MemoryScript[];

  constructor(scripts: readonly MemoryScript[]) {
    this.scripts = [...scripts];
  }

  async form(input: MemoryFormationInput): Promise<unknown> {
    this.requests.push(input);
    const script = this.scripts.shift();
    if (script === undefined) {
      throw new Error("OFFLINE_MEMORY_SCRIPT_EXHAUSTED");
    }
    return typeof script === "function" ? script(input) : script;
  }
}
