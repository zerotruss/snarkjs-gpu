# Security policy

## Read this first

`snarkjs-gpu` runs parts of a zero-knowledge proof on the GPU through zk-gpu, which is
**not audited** and **not constant-time**. A proof made with it is checked by the same verifier as any other
proof, but the code that handles your secret witness and scalars has had no security review. Do not use it where
a timing side channel or an unreviewed implementation is unacceptable.

The adapter works by wrapping functions of snarkjs's ffjavascript at run time. It is tested only with the versions
named in the README; other versions may behave differently, in which case it falls back to the CPU or fails.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private reporting: open the **Security**
tab of this repository and choose **Report a vulnerability**. Include what you found, how to reproduce it and which
versions you used (snarkjs, ffjavascript, browser or Node, operating system, GPU).

You should get a first reply within about a week. This is a small volunteer project, so there is no formal
timeline for fixes; a proof that verifies but is wrong, or a leak of witness data, is treated as the highest priority.

## Supported versions

Only the latest release is supported.
