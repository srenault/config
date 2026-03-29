# TypeScript exhaustive switch

In switch statements over discriminated unions or enums, use a `never` check in the default case so newly added variants cause compile-time failures until handled.

```typescript
// Good
switch (action.type) {
  case "increment":
    return state + 1;
  case "decrement":
    return state - 1;
  default: {
    const _exhaustive: never = action.type;
    throw new Error(`Unhandled action type: ${_exhaustive}`);
  }
}
```
