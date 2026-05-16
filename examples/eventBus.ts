type Handler<T = unknown> = (event: T) => void;

// Describes the API for the AI code generator when this module is used as a test target
export const __lld_api = `
  createEventBus() -> { publish, subscribe } | _subject IS the bus object in tests
  _subject.subscribe(topic, handler) -> unsubscribeFn | register handler; returns () => void to unsubscribe
  _subject.publish(topic, event) -> void | call all handlers for topic synchronously
  For spy-based tests: const spy = mock(() => {}); _subject.subscribe("topic", spy); _subject.publish("topic", evt); expect(spy).toHaveBeenCalledWith(evt)
  For unsubscribe tests: const unsub = _subject.subscribe("topic", spy); unsub(); _subject.publish("topic", {}); expect(spy).not.toHaveBeenCalled()
`;

export const orderPreserved = () => {
  const bus = createEventBus();
  const order: string[] = [];
  bus.subscribe("test", () => order.push("first"));
  bus.subscribe("test", () => order.push("second"));
  bus.publish("test", {});
  return order;
};

export function createEventBus() {
  const subs = new Map<string, Handler[]>();

  return {
    publish(topic: string, event: unknown): void {
      for (const handler of subs.get(topic) ?? []) {
        try { handler(event); } catch { /* isolate */ }
      }
    },

    subscribe(topic: string, handler: Handler): () => void {
      if (!subs.has(topic)) subs.set(topic, []);
      subs.get(topic)!.push(handler);
      return () => {
        const list = subs.get(topic);
        if (list) {
          const i = list.indexOf(handler);
          if (i >= 0) list.splice(i, 1);
        }
      };
    },
  };
}
