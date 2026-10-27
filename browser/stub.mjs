// Stands in for Node-only modules (fs, path, readline, ...) when bundling snarkjs for a browser.
// snarkjs only touches them for real files; the browser path uses in-memory files.
export const O_TRUNC = 0, O_CREAT = 0, O_RDWR = 0, O_EXCL = 0, O_RDONLY = 0;
export default {};
