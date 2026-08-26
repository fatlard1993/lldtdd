type Handler<T = unknown> = (event: T) => void;

export const __lld_api = `
  createEventBus() -> { publish, subscribe } | _subject IS the bus object in tests
  _subject.subscribe(topic, handler) -> unsubscribeFn | register handler; returns () => void to unsubscribe
  _subject.publish(topic, event) -> void | call all handlers for topic synchronously
`;

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
