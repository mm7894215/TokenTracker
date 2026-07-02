function mockPlatform(t, value) {
  if (t.mock && typeof t.mock.property === "function") {
    t.mock.property(process, "platform", value);
    return;
  }
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  t.after(() => Object.defineProperty(process, "platform", original));
}

function mockMethod(t, obj, name, impl) {
  if (t.mock && typeof t.mock.method === "function") {
    t.mock.method(obj, name, impl);
    return;
  }
  const original = obj[name];
  obj[name] = impl;
  t.after(() => { obj[name] = original; });
}

module.exports = { mockPlatform, mockMethod };
