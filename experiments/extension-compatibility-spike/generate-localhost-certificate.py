from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
from pathlib import Path
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=True)
key = ec.generate_private_key(ec.SECP256R1())
subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Vast compatibility localhost")])
now = datetime.now(timezone.utc)
certificate = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(issuer)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - timedelta(minutes=1))
    .not_valid_after(now + timedelta(hours=6))
    .add_extension(
        x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ip_address("127.0.0.1"))]),
        critical=False,
    )
    .sign(key, hashes.SHA256())
)
(output / "localhost-key.pem").write_bytes(
    key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
)
(output / "localhost-cert.pem").write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
