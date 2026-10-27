# Browser CA distrust policy

`distrusted-cas.json` is a Chrome machine policy that sets
[`CADistrustedCertificates`](https://chromeenterprise.google/policies/#CADistrustedCertificates)
to eight eMudhra intermediate CA certificates whose private keys were disclosed as
recoverable on 20 October 2026 (<https://emudhra.we-have-a-problem.com/>). Anyone with
those keys can issue a certificate for any host that the browser accepts.

Chrome distrusts a listed certificate by its public key (SubjectPublicKeyInfo), so one
certificate per key also covers that key's cross-signed certificates. Each of these
intermediates also has a certificate issued by `AAA Certificate Services`.

| Intermediate | SPKI SHA-256 | Listed certificate (crt.sh id, DER SHA-256) |
| --- | --- | --- |
| EM DV TLS CA - G3B | `ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105` | [18286207191](https://crt.sh/?id=18286207191), `42c4accd12c4f59597925e1a08a7a90102608543809308d50ec427e118ba1493` |
| EM DV TLS CA - G3C | `49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f` | [18286207186](https://crt.sh/?id=18286207186), `0164d7ceae5bb909c272af151ff44b1177ae9b47d9424b94f1d9558c30934d19` |
| EM EV TLS CA - G3B | `e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41` | [18286207187](https://crt.sh/?id=18286207187), `e7568fe6e12331f4fd7de61da4c7559d0f8eb192a218d4741a3ba75184333838` |
| EM EV TLS CA - G3C | `5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0` | [18286207182](https://crt.sh/?id=18286207182), `432ec25f0d28de9006d97bf752f17bbb2cd41f669933fcb072d9a1148d0261f3` |
| EM OV TLS CA - G3B | `43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b` | [18286207195](https://crt.sh/?id=18286207195), `98b896625c0c230adeec3eb2cf6aad5001ecf9156a68644e82374ce5833bc25b` |
| EM OV TLS CA - G3C | `63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8` | [18286207177](https://crt.sh/?id=18286207177), `cb6e15165ac802e9b3f993f16c25d41f4e81c21ebde71ae1b012ac00bf9c7c3f` |
| EM OV CS CA - G3B | `ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6` | [18286207189](https://crt.sh/?id=18286207189), `9e39de2881273acc225a149c72ba3e0f51424963669ab633ee1dc7df5db067b4` |
| EM OV CS CA - G3C | `92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30` | [18286207185](https://crt.sh/?id=18286207185), `4b2460a466f95fd40113bcdcca2ceb29b3b093921de45474da7df48874c630b1` |

The key set matches Go's `crypto/x509` `distrustedSPKIHashes` (golang/go commit
`7f86f957633ee31a1c17a1eb8452ca7a3d9bc141`). Chrome's CRLSet 10864 blocks the six TLS
keys. The two code-signing (CS) intermediates cannot issue TLS certificates that Chrome
accepts, but their keys are equally exposed, so the policy lists them too.

## Why a policy file

Chrome ships the same distrust in its CRLSet, a list it downloads in the background.
Patchright and `docker/neko/start-chromium.sh` launch with
`--disable-background-networking`, and every run starts a fresh process, so a run cannot
count on having the current CRLSet. A machine policy applies from the first request.

## Where it is installed

Chromium reads machine policy from a directory that depends on its branding, and it
ignores a file in any other directory:

| Browser | Directory |
| --- | --- |
| Chrome for Testing (Patchright's amd64 build) | `/etc/opt/chrome_for_testing/policies/managed/` |
| Google Chrome | `/etc/opt/chrome/policies/managed/` |
| Chromium | `/etc/chromium/policies/managed/` |

`Dockerfile` and `deploy/docker/Dockerfile` install the file for Chrome for Testing and
Chromium. `docker/neko/Dockerfile` installs it for all three, because
`start-chromium.sh` falls back to Google Chrome and then to system Chromium. Each copy is
`pdpp-distrusted-cas.json`, root-owned, mode 0644, next to any other policy file.

## Checks

- `scripts/chrome-distrust-policy.test.ts` checks that every entry is a CA certificate
  whose key is in the set above, that every key is listed once, and that each Dockerfile
  installs the file in the directories above.
- `deploy/docker/check-chrome-distrust-policy.sh <image>` starts each browser in a built
  image and requires `chrome://policy` to show this exact value with status OK. The
  `docker-images` workflow runs it on the `core`, `reference-browser` and n.eko images.

To change the set, edit `distrusted-cas.json`, `COMPROMISED_SPKIS` in the test, and the
table above.
