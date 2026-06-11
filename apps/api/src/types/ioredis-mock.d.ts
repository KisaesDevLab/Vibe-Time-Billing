// SPDX-License-Identifier: Elastic-2.0
declare module 'ioredis-mock' {
  import { Redis } from 'ioredis';
  export default class RedisMock extends Redis {
    constructor(options?: unknown);
  }
}
