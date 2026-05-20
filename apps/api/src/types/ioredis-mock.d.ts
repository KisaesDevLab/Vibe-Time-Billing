// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
declare module 'ioredis-mock' {
  import { Redis } from 'ioredis';
  export default class RedisMock extends Redis {
    constructor(options?: unknown);
  }
}
