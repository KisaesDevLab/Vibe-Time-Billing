// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
declare module 'ioredis-mock' {
  import { Redis } from 'ioredis';
  export default class RedisMock extends Redis {
    constructor(options?: unknown);
  }
}
