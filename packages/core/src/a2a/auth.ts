import type { User } from '@a2a-js/sdk/server';

import type { Operator } from '../operators/types.js';

export class A2AOperatorUser implements User {
  constructor(readonly operator: Operator) {}

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return this.operator.operatorId;
  }
}
