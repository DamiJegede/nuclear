//! The secure channel between an Orb and its terminal (docs/ORB.md §8a). Everything here is pure computation so it runs under
//! `cargo test`; the board supplies randomness (`nonce_o`), the fleet key `K_orb` (compiled in, see [`fleet_key`])
//! and the stored [`Binding`].
//!
//! Key hierarchy (HMAC-SHA256 is the only primitive besides the AEAD): one fleet key `K_orb` (`ORB_KEY_V1`) is built into the firmware and held by
//! the API; no Orb is provisioned individually. A bind is authorized by the API (`bind_proof`, tied to this Orb's uid and fresh `nonce_o`),
//! which gives both sides a per-binding `K_bind`. Frames are ChaCha20-Poly1305 with a strictly increasing counter per direction.
use chacha20poly1305::aead::{AeadInPlace, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce, Tag};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub const KEY_LEN: usize = 32;
pub const PROOF_LEN: usize = 32;
pub const TAG_LEN: usize = 16;
/// Counter (8 bytes) in front of every sealed frame.
pub const FRAME_OVERHEAD: usize = 8 + TAG_LEN;

/// `HMAC-SHA256(key, label || 0x00 || parts...)`.
pub fn prf(key: &[u8], label: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac takes any key length");
    m.update(label.as_bytes());
    m.update(&[0]);
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

/// Constant-time check that `expected == PRF(key, label, parts)`.
fn prf_matches(key: &[u8], label: &str, parts: &[&[u8]], expected: &[u8; 32]) -> bool {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac takes any key length");
    m.update(label.as_bytes());
    m.update(&[0]);
    for p in parts {
        m.update(p);
    }
    m.verify_slice(expected).is_ok()
}

/// The fleet key compiled into the firmware: build with `ORB_KEY_V1=<64 hex chars> cargo build --release`. `None` when the build did not set it.
pub const FLEET_KEY_HEX: Option<&str> = option_env!("ORB_KEY_V1");

/// Parses 64 hex characters into a key (None on any other input).
pub fn parse_key(hex: &str) -> Option<[u8; KEY_LEN]> {
    let b = hex.as_bytes();
    if b.len() != 2 * KEY_LEN {
        return None;
    }
    let nib = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut k = [0u8; KEY_LEN];
    for i in 0..KEY_LEN {
        k[i] = nib(b[2 * i])? << 4 | nib(b[2 * i + 1])?;
    }
    Some(k)
}

/// The key this firmware image was built with.
pub fn fleet_key() -> Option<[u8; KEY_LEN]> {
    FLEET_KEY_HEX.and_then(parse_key)
}

/// What an Orb keeps once bound: the binding id the API issued and the per-binding key. 48 bytes in the persistent slot.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Binding {
    pub id: [u8; 16],
    pub key: [u8; 32],
}
impl core::fmt::Debug for Binding {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "Binding({:02x?}, key hidden)", self.id)
    }
}

/// The Orb's side of the handshake for ONE connection: `nonce_o` is fresh random bytes sent in `Hello`.
pub struct Authorizer {
    k_orb: [u8; 32],
    uid: [u8; 6],
    nonce_o: [u8; 16],
}

impl Authorizer {
    pub fn new(k_orb: [u8; 32], uid: [u8; 6], nonce_o: [u8; 16]) -> Self {
        Authorizer { k_orb, uid, nonce_o }
    }

    pub fn nonce_o(&self) -> [u8; 16] {
        self.nonce_o
    }

    /// Bind: the terminal relays the API's authorization (`binding_id`, `proof`). On success returns the binding to store and the Orb's
    /// own proof for `HandshakeResult` (so the terminal knows the Orb holds `K_bind`).
    pub fn verify_bind(&self, binding_id: &[u8; 16], proof: &[u8; 32]) -> Option<(Binding, [u8; 32])> {
        if !prf_matches(&self.k_orb, "bind-auth-v1", &[&self.uid, binding_id, &self.nonce_o], proof) {
            return None;
        }
        let key = prf(&self.k_orb, "bind-key-v1", &[&self.uid, binding_id]);
        let binding = Binding { id: *binding_id, key };
        Some((binding, prf(&key, "orb-proof-v1", &[&self.nonce_o, binding_id])))
    }

    /// Resume: the terminal proves it holds `K_bind` for this connection's `nonce_o` and its own fresh `nonce_t`. Returns the Orb's proof.
    pub fn verify_resume(&self, binding: &Binding, nonce_t: &[u8; 16], proof: &[u8; 32]) -> Option<[u8; 32]> {
        if !prf_matches(&binding.key, "term-proof-v1", &[&self.nonce_o, nonce_t], proof) {
            return None;
        }
        Some(prf(&binding.key, "orb-resume-v1", &[&self.nonce_o, nonce_t]))
    }

    /// The channel for an accepted handshake; `generation` is the session generation the Orb assigned.
    pub fn channel(&self, binding: &Binding, generation: u16) -> Channel {
        Channel::new(&binding.key, &self.nonce_o, &binding.id, generation, Side::Orb)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Orb,
    Terminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelError {
    /// Output buffer too small, or a frame shorter than counter + tag.
    Length,
    /// Counter not above the last accepted one: a replay, a duplicate or an old frame.
    Replay,
    /// The tag did not verify (tampered, wrong key, wrong session or wrong direction).
    Auth,
    /// 2^64 frames sent; a new session is required.
    Exhausted,
}

/// Authenticated, encrypted frames for one session. Counters start at 1 and only move forward; a frame that fails authentication does
/// not advance the receive counter.
pub struct Channel {
    send_key: [u8; 32],
    recv_key: [u8; 32],
    generation: u16,
    send_ctr: u64,
    recv_ctr: u64,
}

impl Channel {
    pub fn new(k_bind: &[u8; 32], nonce_o: &[u8; 16], binding_id: &[u8; 16], generation: u16, side: Side) -> Self {
        let gen = generation.to_be_bytes();
        let t2o = prf(k_bind, "session-t2o-v1", &[nonce_o, binding_id, &gen]);
        let o2t = prf(k_bind, "session-o2t-v1", &[nonce_o, binding_id, &gen]);
        let (send_key, recv_key) = match side {
            Side::Orb => (o2t, t2o),
            Side::Terminal => (t2o, o2t),
        };
        Channel { send_key, recv_key, generation, send_ctr: 0, recv_ctr: 0 }
    }

    fn nonce(ctr: u64) -> [u8; 12] {
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&ctr.to_be_bytes());
        n
    }

    fn aad(&self) -> [u8; 3] {
        let g = self.generation.to_be_bytes();
        [1, g[0], g[1]]
    }

    /// `out` = counter (8, big-endian) || ciphertext || tag (16). Returns the frame length.
    pub fn seal(&mut self, plain: &[u8], out: &mut [u8]) -> Result<usize, ChannelError> {
        let total = plain.len() + FRAME_OVERHEAD;
        if out.len() < total {
            return Err(ChannelError::Length);
        }
        let ctr = self.send_ctr.checked_add(1).ok_or(ChannelError::Exhausted)?;
        out[..8].copy_from_slice(&ctr.to_be_bytes());
        out[8..8 + plain.len()].copy_from_slice(plain);
        let aad = self.aad();
        let cipher = ChaCha20Poly1305::new((&self.send_key).into());
        let tag = cipher
            .encrypt_in_place_detached(Nonce::from_slice(&Self::nonce(ctr)), &aad, &mut out[8..8 + plain.len()])
            .map_err(|_| ChannelError::Auth)?;
        out[8 + plain.len()..total].copy_from_slice(&tag);
        self.send_ctr = ctr;
        Ok(total)
    }

    /// Verifies and decrypts into `out`; returns the plaintext length.
    pub fn open(&mut self, frame: &[u8], out: &mut [u8]) -> Result<usize, ChannelError> {
        if frame.len() < FRAME_OVERHEAD {
            return Err(ChannelError::Length);
        }
        let n = frame.len() - FRAME_OVERHEAD;
        if out.len() < n {
            return Err(ChannelError::Length);
        }
        let ctr = u64::from_be_bytes(frame[..8].try_into().unwrap());
        if ctr <= self.recv_ctr {
            return Err(ChannelError::Replay);
        }
        out[..n].copy_from_slice(&frame[8..8 + n]);
        let aad = self.aad();
        let cipher = ChaCha20Poly1305::new((&self.recv_key).into());
        cipher
            .decrypt_in_place_detached(Nonce::from_slice(&Self::nonce(ctr)), &aad, &mut out[..n], Tag::from_slice(&frame[8 + n..]))
            .map_err(|_| ChannelError::Auth)?;
        self.recv_ctr = ctr;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
    }
    fn a<const N: usize>(s: &str) -> [u8; N] {
        h(s).try_into().unwrap()
    }

    // Vectors from docs/orb-protocol-vectors.md (generated by an independent Python reference).
    const ROOT: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const UID: &str = "0211223344ff";
    const NONCE_O: &str = "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf";
    const BINDING_ID: &str = "b0b1b2b3b4b5b6b7b8b9babbbcbdbebf";
    const NONCE_T: &str = "c0c1c2c3c4c5c6c7c8c9cacbcccdcecf";

    fn orb() -> Authorizer {
        Authorizer::new(a(ROOT), a(UID), a(NONCE_O))
    }

    #[test]
    fn key_parsing() {
        assert_eq!(parse_key(ROOT), Some(a(ROOT)));
        assert_eq!(parse_key("00"), None);
        assert_eq!(parse_key(&"zz".repeat(32)), None);
    }

    #[test]
    fn bind_vector() {
        let proof = a("65e43504815dc989a54c047d0460819962401aaa1ebe287b27e8ceb929a88392");
        let (b, orb_proof) = orb().verify_bind(&a(BINDING_ID), &proof).unwrap();
        assert_eq!(b.key.to_vec(), h("a669767ce4577d47d23b35283c54c52c895193c4afdb6715b5ca04f2b2ec90af"));
        assert_eq!(orb_proof.to_vec(), h("cceb9d70218c738390c1a320e367ae8735c649b74bd129f5266e7b26d3444b1a"));
    }

    #[test]
    fn bind_refuses_wrong_nonce_binding_or_orb() {
        let proof: [u8; 32] = a("65e43504815dc989a54c047d0460819962401aaa1ebe287b27e8ceb929a88392");
        let mut other = a::<16>(BINDING_ID);
        other[0] ^= 1;
        assert!(orb().verify_bind(&other, &proof).is_none());                       // authorization for another binding id
        let stale = Authorizer::new(a(ROOT), a(UID), [0; 16]);
        assert!(stale.verify_bind(&a(BINDING_ID), &proof).is_none());               // authorization issued for another connection (replay)
        let mut uid = a::<6>(UID);
        uid[5] ^= 1;
        let other_orb = Authorizer::new(a(ROOT), uid, a(NONCE_O));
        assert!(other_orb.verify_bind(&a(BINDING_ID), &proof).is_none());           // authorization for another Orb (the uid is bound into the proof)
        let mut bad = proof;
        bad[31] ^= 1;
        assert!(orb().verify_bind(&a(BINDING_ID), &bad).is_none());
    }

    fn binding() -> Binding {
        let proof = a("65e43504815dc989a54c047d0460819962401aaa1ebe287b27e8ceb929a88392");
        orb().verify_bind(&a(BINDING_ID), &proof).unwrap().0
    }

    #[test]
    fn resume_vector_and_refusals() {
        let b = binding();
        let proof = a("97c5228ada8f31bcb2512b41ee7bd3350ab1dac5bfd307eea92a78d96cae19d9");
        assert_eq!(orb().verify_resume(&b, &a(NONCE_T), &proof).unwrap().to_vec(), h("308ddb49160b29945bb13fb0b30fd9013be4aa9cacd387e4670ef716b9815bbf"));
        let mut other_t = a::<16>(NONCE_T);
        other_t[0] ^= 1;
        assert!(orb().verify_resume(&b, &other_t, &proof).is_none());
        let stale = Authorizer::new(a(ROOT), a(UID), [1; 16]);
        assert!(stale.verify_resume(&b, &a(NONCE_T), &proof).is_none());            // a recorded resume cannot be replayed on a new connection
    }

    #[test]
    fn frame_vectors_and_round_trip() {
        let b = binding();
        let mut orb_ch = orb().channel(&b, 7);
        let mut term = Channel::new(&b.key, &a(NONCE_O), &b.id, 7, Side::Terminal);
        let plain = h("020001000200000001");
        let mut buf = [0u8; 64];
        let n = term.seal(&plain, &mut buf).unwrap();
        assert_eq!(buf[..n].to_vec(), h("000000000000000174dc65fda33818d5e7a08bb9904fda8aa048f44efd94e5ac34"));
        let mut out = [0u8; 64];
        let m = orb_ch.open(&buf[..n], &mut out).unwrap();
        assert_eq!(&out[..m], &plain[..]);
        orb_ch.seal(&plain, &mut buf).unwrap();                                      // counter 1 in this direction...
        let n2 = orb_ch.seal(&plain, &mut buf).unwrap();                             // ...and 2 here
        assert_eq!(buf[..n2].to_vec(), h("00000000000000029587de8bb36126192f4bc1b03700625752d373a7fccdfeb991"));
        assert_eq!(term.open(&buf[..n2], &mut out).unwrap(), plain.len());
    }

    #[test]
    fn replay_tamper_direction_and_session_are_refused() {
        let b = binding();
        let mut orb_ch = orb().channel(&b, 7);
        let mut term = Channel::new(&b.key, &a(NONCE_O), &b.id, 7, Side::Terminal);
        let mut buf = [0u8; 64];
        let mut out = [0u8; 64];
        let n = term.seal(b"hello", &mut buf).unwrap();
        let frame = buf;
        assert!(orb_ch.open(&frame[..n], &mut out).is_ok());
        assert_eq!(orb_ch.open(&frame[..n], &mut out), Err(ChannelError::Replay));          // replay
        let n2 = term.seal(b"again", &mut buf).unwrap();
        let mut tampered = buf;
        tampered[9] ^= 1;
        assert_eq!(orb_ch.open(&tampered[..n2], &mut out), Err(ChannelError::Auth));         // tampered
        assert!(orb_ch.open(&buf[..n2], &mut out).is_ok());                                  // a failed frame did not burn the counter
        // A frame the Orb itself sent cannot be played back at it (different direction key).
        let n3 = orb_ch.seal(b"mine", &mut buf).unwrap();
        let mut orb2 = orb().channel(&b, 7);
        assert_eq!(orb2.open(&buf[..n3], &mut out), Err(ChannelError::Auth));
        // Another session generation does not open this session's frames.
        let mut g8 = orb().channel(&b, 8);
        let n4 = term.seal(b"x", &mut buf).unwrap();
        assert_eq!(g8.open(&buf[..n4], &mut out), Err(ChannelError::Auth));
        assert_eq!(orb_ch.open(&buf[..4], &mut out), Err(ChannelError::Length));
    }
}
