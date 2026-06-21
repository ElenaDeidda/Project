// plan_base.js — classe base condivisa dai piani di plans.js e plans_channel.js.
// Estratta a parte per evitare un import circolare tra i due file.

export class PlanBase {
    #stopped = false;
    get stopped()    { return this.#stopped; }
    get shouldStop() { return () => this.#stopped; }
    stop()           { this.#stopped = true; }
}
