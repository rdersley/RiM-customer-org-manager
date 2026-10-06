export default class Resolver {
  constructor() { this.definitions = {}; }
  define(name, fn) { this.definitions[name] = fn; }
  getDefinitions() { return this.definitions; }
}
