"""Verify both XML signatures and every package file digest, without private keys."""
import argparse, base64, hashlib, zipfile
from urllib.parse import unquote
from lxml import etree
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

p = argparse.ArgumentParser(); p.add_argument('package'); args = p.parse_args()
ns = {'ds': 'http://www.w3.org/2000/09/xmldsig#'}
with zipfile.ZipFile(args.package) as z:
    contents = {n:z.read(n) for n in z.namelist() if not n.endswith('/')}
    for name in ('author-signature.xml', 'signature1.xml'):
        sig = etree.fromstring(contents[name])
        signed = sig.find('ds:SignedInfo', ns)
        cert = x509.load_der_x509_certificate(base64.b64decode(sig.find('.//ds:X509Certificate',ns).text))
        algo = signed.find('ds:SignatureMethod',ns).get('Algorithm')
        digest = hashes.SHA512() if algo.endswith('sha512') else hashes.SHA256()
        canonical = etree.tostring(signed, method='c14n', exclusive=True)
        cert.public_key().verify(base64.b64decode(sig.find('ds:SignatureValue',ns).text), canonical, padding.PKCS1v15(), digest)
        references = set()
        for ref in signed.findall('ds:Reference',ns):
            uri = ref.get('URI'); method=ref.find('ds:DigestMethod',ns).get('Algorithm')
            if uri.startswith('#'):
                target=sig.xpath('//*[@Id=$id]',id=uri[1:])[0]
                # Canonicalize an independent subtree, matching the signer's XML document.
                data=etree.tostring(etree.fromstring(etree.tostring(target)),method='c14n')
            else:
                data=contents[unquote(uri)];references.add(unquote(uri))
            actual=(hashlib.sha512 if method.endswith('sha512') else hashlib.sha256)(data).digest()
            assert actual == base64.b64decode(ref.find('ds:DigestValue',ns).text), 'Digest mismatch: '+uri
        expected=set(contents)-{'author-signature.xml','signature1.xml'}
        if name=='signature1.xml':expected.add('author-signature.xml')
        assert references==expected, 'Signature omits package content'
        print(name+': signature and '+str(len(references))+' file digests verified')
    config=etree.fromstring(contents['config.xml'])
    app=config.find('{http://tizen.org/ns/widgets}application')
    assert app.get('id')=='PlatyNite1.Platynite' and app.get('package')=='PlatyNite1'
    print('Verified separate Platynite package identity')
