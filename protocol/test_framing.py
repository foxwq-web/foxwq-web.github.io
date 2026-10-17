import unittest
from protocol.framing import Frame, decode_one, encode, gateway_payload, split_gateway


class WireTests(unittest.TestCase):
    def test_fixed_packet(self):
        # Command 2000, no flags/payload: Adler-32(07 d0 00) = 01 b8 00 d8.
        fixture = bytes.fromhex('0007 07d0 00 01b800d8')
        self.assertEqual(encode(2000, b''), fixture)
        self.assertEqual(decode_one(fixture), (Frame(2000, 0, b''), 9))
        for i in range(len(fixture)):
            self.assertIsNone(decode_one(fixture[:i]))

    def test_checksum_failure(self):
        with self.assertRaisesRegex(ValueError, 'Adler'):
            decode_one(bytes.fromhex('0007 07d0 00 01b800d9'))

    def test_extended_header_boundary(self):
        small = encode(7000, b'x' * (0x7ffe - 7))
        large = encode(7000, b'x' * (0x7fff - 7))
        self.assertEqual(small[:2], bytes.fromhex('7ffe'))
        self.assertEqual(large[:8], bytes.fromhex('7fff 000b 00007fff'))
        self.assertEqual(decode_one(large)[0].payload, b'x' * (0x7fff - 7))

    def test_compressed_stream_and_concatenation(self):
        packet = encode(0x6658, b'a' * 5000, compress=True)
        self.assertEqual(packet[4], 2)
        frame, consumed = decode_one(packet + encode(2000, b''))
        self.assertEqual(frame.payload, b'a' * 5000)
        self.assertEqual(consumed, len(packet))
        with self.assertRaises(ValueError):
            decode_one(packet, max_size=100)

    def test_gateway_envelope(self):
        fixture = bytes.fromhex('0002 0801 1002')
        self.assertEqual(gateway_payload(bytes.fromhex('0801'), bytes.fromhex('1002')), fixture)
        self.assertEqual(split_gateway(fixture), (bytes.fromhex('0801'), bytes.fromhex('1002')))


if __name__ == '__main__':
    unittest.main()
