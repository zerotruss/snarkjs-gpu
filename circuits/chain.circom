pragma circom 2.0.0;

// A chain of N squarings: exactly N constraints. Used to get a proof of any chosen size.
template Chain(N) {
    signal input x;
    signal output y;
    signal s[N + 1];
    s[0] <== x;
    for (var i = 0; i < N; i++) {
        s[i + 1] <== s[i] * s[i] + i;
    }
    y <== s[N];
}
