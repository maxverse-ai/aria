export default {
  generate() {
    throw new Error('QR code rendering is unavailable in embedded worker mode');
  },
};
