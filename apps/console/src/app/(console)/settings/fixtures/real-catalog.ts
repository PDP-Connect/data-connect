// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The ways the Gozar 0.5.1 catalog lists, as the host's inventory returns them:
// label, reach, transport, lifetime availability and the cost and traffic facts.
// Captured from the packaged library's own listing on a machine with no
// prerequisites configured; prerequisites are left empty so each test sets the
// ones it needs. Tests name ways by key, so product code under test never has to.

export const wayIds = {
  temporary: "localhost-run",
  funnel: "tailscale-funnel",
  cloudflare: "cloudflare-named",
  ngrok: "ngrok-https-edge",
  tailnet: "tailscale-private",
  lan: "lan",
  ownAddress: "own-address",
  ngrokTls: "ngrok-tls-passthrough",
  ngrokTcp: "ngrok-tcp-passthrough",
  tunnl: "tunnl-gg",
} as const;

const shapes = [
  {
    "providerId": "tailscale-funnel",
    "label": "Tailscale Funnel",
    "reach": "internet",
    "transport": "https",
    "availability": {
      "session": {
        "state": "available",
        "reason": "admitted"
      },
      "attached": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      },
      "durable": {
        "state": "available",
        "reason": "admitted"
      }
    },
    "prerequisites": [
      {
        "id": "local-setup",
        "label": "Local prerequisites",
        "state": "present",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "client-proof",
        "label": "Independent client proof",
        "state": "unknown",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      }
    ],
    "facts": [
      {
        "id": "cost-detail",
        "group": "cost",
        "label": "Cost details",
        "known": true,
        "value": "Free on the Personal plan (up to 6 users); Funnel is available on all plans, with non-configurable bandwidth limits.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "payload-readers",
        "group": "privacy",
        "label": "Payload readers",
        "known": true,
        "value": "The relay cannot read the traffic; TLS ends on this computer.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      }
    ]
  },
  {
    "providerId": "tailscale-private",
    "label": "Tailscale private Serve",
    "reach": "tailnet",
    "transport": "https",
    "availability": {
      "session": {
        "state": "available",
        "reason": "admitted"
      },
      "attached": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      },
      "durable": {
        "state": "available",
        "reason": "admitted"
      }
    },
    "prerequisites": [
      {
        "id": "local-setup",
        "label": "Local prerequisites",
        "state": "present",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "client-proof",
        "label": "Independent client proof",
        "state": "unknown",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      }
    ],
    "facts": [
      {
        "id": "cost-detail",
        "group": "cost",
        "label": "Cost details",
        "known": true,
        "value": "Tailscale pricing is documented, but the Serve page does not say which plans include Serve.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "payload-readers",
        "group": "privacy",
        "label": "Payload readers",
        "known": true,
        "value": "Architecture classification: HTTPS terminates on this device in local tailscaled, which can read the payload. Tailnet-only reach does not hide publicly logged certificate names. The upstream/application TLS boundary is not established by tailnet reach. This is not a live deployment observation.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      }
    ]
  },
  {
    "providerId": "localhost-run",
    "label": "localhost.run trial",
    "reach": "internet",
    "transport": "https",
    "availability": {
      "session": {
        "state": "available",
        "reason": "admitted"
      },
      "attached": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      },
      "durable": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      }
    },
    "prerequisites": [
      {
        "id": "local-setup",
        "label": "Local prerequisites",
        "state": "present",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      }
    ],
    "facts": [
      {
        "id": "cost-detail",
        "group": "cost",
        "label": "Cost details",
        "known": true,
        "value": "The free tier costs nothing and needs no signup; its domains change regularly and have a speed limit.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "payload-readers",
        "group": "privacy",
        "label": "Payload readers",
        "known": true,
        "value": "The localhost.run relay can read the traffic.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      }
    ]
  },
  {
    "providerId": "lan",
    "label": "Local network",
    "reach": "lan",
    "transport": "http",
    "availability": {
      "session": {
        "state": "action-required",
        "reason": "provider-action-required"
      },
      "attached": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      },
      "durable": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      }
    },
    "prerequisites": [
      {
        "id": "local-setup",
        "label": "Local prerequisites",
        "state": "present",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      }
    ],
    "facts": [
      {
        "id": "cost-detail",
        "group": "cost",
        "label": "Cost details",
        "known": true,
        "value": "Gozar charges nothing and there is no provider; the owned local forwarder uses your own network.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "payload-readers",
        "group": "privacy",
        "label": "Payload readers",
        "known": true,
        "value": "Traffic is unencrypted; the local network path (unencrypted HTTP) can read it.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "alternative-cost",
        "group": "cost",
        "label": "Account-specific alternative cost and quota",
        "known": true,
        "value": "not-applicable",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      }
    ]
  },
  {
    "providerId": "own-address",
    "label": "Your own HTTPS address",
    "reach": "unknown",
    "transport": "https",
    "availability": {
      "session": {
        "state": "action-required",
        "reason": "provider-action-required"
      },
      "attached": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      },
      "durable": {
        "state": "action-required",
        "reason": "provider-action-required"
      }
    },
    "prerequisites": [
      {
        "id": "local-setup",
        "label": "Local prerequisites",
        "state": "present",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      }
    ],
    "facts": [
      {
        "id": "cost-detail",
        "group": "cost",
        "label": "Cost details",
        "known": true,
        "value": "Gozar charges nothing; your own domain, hosting and certificate cost whatever you pay for them.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "payload-readers",
        "group": "privacy",
        "label": "Payload readers",
        "known": true,
        "value": "Architecture classification: the owner-managed proxy may read payloads; its actual TLS termination and reader access have not been observed. Selecting this address does not grant Gozar authority over the proxy or its owner. This is not a live deployment observation.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      }
    ]
  },
  {
    "providerId": "ngrok-https-edge",
    "label": "ngrok HTTPS edge",
    "reach": "internet",
    "transport": "https",
    "availability": {
      "session": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      },
      "attached": {
        "state": "action-required",
        "reason": "provider-action-required"
      },
      "durable": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      }
    },
    "prerequisites": [
      {
        "id": "guided-setup",
        "label": "Guided account and listener setup",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "runtime",
        "label": "Runtime module",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "credential",
        "label": "Saved credential",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "domain",
        "label": "Assigned development or reserved domain",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      }
    ],
    "facts": [
      {
        "id": "cost-detail",
        "group": "cost",
        "label": "Cost details",
        "known": true,
        "value": "The Free plan accepts the assigned development domain. Reserved ngrok-branded domains and bring-your-own domains have separate account entitlements; current prices and account-specific charges are not verified.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "payload-readers",
        "group": "privacy",
        "label": "Payload readers",
        "known": true,
        "value": "The ngrok edge can read the traffic.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      }
    ]
  },
  {
    "providerId": "ngrok-tls-passthrough",
    "label": "ngrok TLS passthrough",
    "reach": "internet",
    "transport": "tls",
    "availability": {
      "session": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      },
      "attached": {
        "state": "detect-only",
        "reason": "http-https-only-in-0.4; raw passthrough deferred by Lead"
      },
      "durable": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      }
    },
    "prerequisites": [
      {
        "id": "runtime",
        "label": "Runtime module",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "credential",
        "label": "Saved credential",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "domain",
        "label": "Reserved domain",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "proof-tool",
        "label": "Synthetic certificate tool",
        "state": "present",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      }
    ],
    "facts": [
      {
        "id": "cost-detail",
        "group": "cost",
        "label": "Cost details",
        "known": true,
        "value": "The ngrok pricing page does not settle the cost of TLS passthrough.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "payload-readers",
        "group": "privacy",
        "label": "Payload readers",
        "known": true,
        "value": "The relay cannot read the traffic; TLS ends on this computer.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "public-plan-requirement",
        "group": "cost",
        "label": "Public plan requirement",
        "known": true,
        "value": "Raw TLS requires paid entitlement; selected account eligibility remains unknown.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      }
    ]
  },
  {
    "providerId": "ngrok-tcp-passthrough",
    "label": "ngrok TCP passthrough",
    "reach": "internet",
    "transport": "tcp",
    "availability": {
      "session": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      },
      "attached": {
        "state": "detect-only",
        "reason": "http-https-only-in-0.4; raw passthrough deferred by Lead"
      },
      "durable": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      }
    },
    "prerequisites": [
      {
        "id": "runtime",
        "label": "Runtime module",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "credential",
        "label": "Saved credential",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      }
    ],
    "facts": [
      {
        "id": "cost-detail",
        "group": "cost",
        "label": "Cost details",
        "known": true,
        "value": "The ngrok pricing page does not settle the cost of TCP passthrough.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "public-plan-requirement",
        "group": "cost",
        "label": "Public plan requirement",
        "known": true,
        "value": "Free TCP requires payment-card verification; selected account eligibility remains unknown.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "payload-readers",
        "group": "privacy",
        "label": "Payload readers",
        "known": true,
        "value": "Architecture classification: the application endpoint receives opaque TCP; TLS termination and intermediary reader access have not been observed. Raw TCP remains detect-only in this release and is not an executable route. This is not a live deployment observation.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      }
    ]
  },
  {
    "providerId": "cloudflare-named",
    "label": "Cloudflare named tunnel",
    "reach": "internet",
    "transport": "https",
    "availability": {
      "session": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      },
      "attached": {
        "state": "action-required",
        "reason": "provider-action-required"
      },
      "durable": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      }
    },
    "prerequisites": [
      {
        "id": "connector-binary",
        "label": "Connector binary",
        "state": "present",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "credential",
        "label": "Saved tunnel credential",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "origin",
        "label": "Published origin",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "gate-port",
        "label": "Local connector port",
        "state": "missing",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      },
      {
        "id": "process-supervisor",
        "label": "Process supervisor",
        "state": "present",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      }
    ],
    "facts": [
      {
        "id": "cost-detail",
        "group": "cost",
        "label": "Cost details",
        "known": true,
        "value": "Cloudflare documents no bandwidth charge for Tunnel; optional products and account-specific services can have separate charges.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "payload-readers",
        "group": "privacy",
        "label": "Payload readers",
        "known": true,
        "value": "The Cloudflare edge can read the traffic.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      }
    ]
  },
  {
    "providerId": "tunnl-gg",
    "label": "tunnl.gg trial",
    "reach": "internet",
    "transport": "https",
    "availability": {
      "session": {
        "state": "available",
        "reason": "admitted"
      },
      "attached": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      },
      "durable": {
        "state": "unsupported",
        "reason": "usage-not-supported"
      }
    },
    "prerequisites": [
      {
        "id": "local-setup",
        "label": "Local prerequisites",
        "state": "present",
        "observedAt": "2026-01-01T00:00:00.000Z",
        "version": {
          "known": false,
          "reason": "not-observed"
        },
        "remedy": null
      }
    ],
    "facts": [
      {
        "id": "cost-detail",
        "group": "cost",
        "label": "Cost details",
        "known": true,
        "value": "The free tier costs nothing and needs no account; Pro is $6 a month or $60 a year and removes time limits and the warning page.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      },
      {
        "id": "payload-readers",
        "group": "privacy",
        "label": "Payload readers",
        "known": true,
        "value": "The tunnl.gg relay can read the traffic.",
        "reason": null,
        "source": null,
        "asOf": null,
        "affectsConsent": false
      }
    ]
  }
] as const;

type Shape = (typeof shapes)[number];

/** One real way, with prerequisites cleared and anything in `over` replacing the rest. */
export function realWay(providerId: string, over: Record<string, unknown> = {}) {
  const shape = shapes.find((item): item is Shape => item.providerId === providerId);
  if (!shape) throw new Error(`No real catalog shape for ${providerId}`);
  return {
    ...structuredClone(shape),
    configuration: { revision: "r1", actions: [], inputRequirements: [], values: {}, credentials: {} },
    prerequisites: [] as unknown[],
    ...over,
  };
}

/** The whole catalog as a fresh machine reports it, prerequisites included. */
export function realInventory(adjust: (provider: ReturnType<typeof realWay>) => void = () => undefined) {
  const providers = shapes.map((shape) => {
    const provider = {
      ...structuredClone(shape),
      configuration: { revision: "r1", actions: [], inputRequirements: [], values: {}, credentials: {} },
    } as unknown as ReturnType<typeof realWay>;
    adjust(provider);
    return provider;
  });
  return { catalogRevision: "c1", observedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1, providers };
}
