pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// Proves that a secret leaf is in a Merkle tree with a known root (a typical privacy-app circuit).
template Merkle(DEPTH) {
    signal input leaf;
    signal input pathElements[DEPTH];
    signal input pathIndices[DEPTH];   // 0 = we are the left child, 1 = the right child
    signal output root;

    signal level[DEPTH + 1];
    level[0] <== leaf;
    component hash[DEPTH];
    component left[DEPTH];
    component right[DEPTH];
    for (var i = 0; i < DEPTH; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        left[i] = Mux1();
        left[i].c[0] <== level[i];
        left[i].c[1] <== pathElements[i];
        left[i].s <== pathIndices[i];
        right[i] = Mux1();
        right[i].c[0] <== pathElements[i];
        right[i].c[1] <== level[i];
        right[i].s <== pathIndices[i];
        hash[i] = Poseidon(2);
        hash[i].inputs[0] <== left[i].out;
        hash[i].inputs[1] <== right[i].out;
        level[i + 1] <== hash[i].out;
    }
    root <== level[DEPTH];
}
