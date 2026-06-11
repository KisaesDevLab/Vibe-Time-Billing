// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';

import { parseConnectorCount } from './cloudflare-tunnel-status';

describe('parseConnectorCount', () => {
  it('sums multiple ha_connections lines and pulls a location label', () => {
    const text = `
# HELP cloudflared_tunnel_ha_connections Active connector connections.
# TYPE cloudflared_tunnel_ha_connections gauge
cloudflared_tunnel_ha_connections{location="lax01",tunnel_id="abc"} 1
cloudflared_tunnel_ha_connections{location="sjc02",tunnel_id="abc"} 1
cloudflared_tunnel_ha_connections{location="dfw01",tunnel_id="abc"} 1
cloudflared_tunnel_ha_connections{location="ord03",tunnel_id="abc"} 1
some_other_metric{x="y"} 42
`;
    const { count, region } = parseConnectorCount(text);
    expect(count).toBe(4);
    expect(region).toBe('lax01');
  });

  it('returns 0 + null when the metric is absent', () => {
    const { count, region } = parseConnectorCount('# nothing here\nfoo 1\n');
    expect(count).toBe(0);
    expect(region).toBeNull();
  });

  it('tolerates missing location label', () => {
    const { count, region } = parseConnectorCount('cloudflared_tunnel_ha_connections 2\n');
    expect(count).toBe(2);
    expect(region).toBeNull();
  });
});
