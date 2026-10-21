//! Persistent state (docs/ORB.md sections 8 and 11): what the Orb must remember across a reboot, and nothing more. No keys (the Orb holds
//! none), no URLs or credentials, no payment amounts: a "has a terminal binding" flag, the identifiers of one unresolved attempt, and the
//! volume setting.
//!
//! The hardware is reached through [`SlotStore`], two fixed slots (flash sectors or NVS records). A record carries a sequence number and a
//! CRC. Saving writes the slot that does **not** hold the newest valid record, so a power cut in the middle of a write can only damage the
//! slot being written; the other still holds the previous good state and the loader picks the newest slot whose CRC checks. Identical
//! state is not written again (flash wear). Board support implements `SlotStore`; tests use [`MemStore`], which can tear a write.

use crate::config::DEFAULT_VOLUME_PERCENT;
use crate::controller::{Action, Input, Unresolved};
use crate::message::Purpose;

pub const SLOT_COUNT: usize = 2;
pub const RECORD_LEN: usize = 28;
const MAGIC: [u8; 2] = *b"OR";
const VERSION: u8 = 1;
const F_BINDING: u8 = 1;
const F_UNRESOLVED: u8 = 2;
const F_MUTED: u8 = 4;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum StoreError {
    /// The device refused or failed the write.
    Write,
}

/// Two fixed record slots. A write may be torn by power loss; the implementation need not make it atomic.
pub trait SlotStore {
    /// The raw bytes of a slot (erased flash reads as all `0xFF`).
    fn read(&self, slot: usize) -> [u8; RECORD_LEN];
    /// Replace the slot's bytes (erase then program on flash).
    fn write(&mut self, slot: usize, bytes: &[u8; RECORD_LEN]) -> Result<(), StoreError>;
}

/// Everything remembered across reboots.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Persisted {
    pub has_binding: bool,
    pub unresolved: Option<Unresolved>,
    pub volume: u8,
    pub muted: bool,
}

impl Default for Persisted {
    fn default() -> Self {
        Persisted { has_binding: false, unresolved: None, volume: DEFAULT_VOLUME_PERCENT, muted: false }
    }
}

/// CRC-16/CCITT-FALSE.
fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

fn encode(seq: u32, p: &Persisted) -> [u8; RECORD_LEN] {
    let mut r = [0u8; RECORD_LEN];
    r[0..2].copy_from_slice(&MAGIC);
    r[2] = VERSION;
    r[3..7].copy_from_slice(&seq.to_be_bytes());
    let mut flags = 0;
    if p.has_binding { flags |= F_BINDING; }
    if p.unresolved.is_some() { flags |= F_UNRESOLVED; }
    if p.muted { flags |= F_MUTED; }
    r[7] = flags;
    r[8] = p.volume;
    if let Some(u) = p.unresolved {
        r[9] = u.purpose as u8;
        r[10..26].copy_from_slice(&u.attempt);
    }
    let crc = crc16(&r[..26]);
    r[26..28].copy_from_slice(&crc.to_be_bytes());
    r
}

fn decode(r: &[u8; RECORD_LEN]) -> Option<(u32, Persisted)> {
    if r[0..2] != MAGIC || r[2] != VERSION || crc16(&r[..26]) != u16::from_be_bytes([r[26], r[27]]) {
        return None;
    }
    let seq = u32::from_be_bytes([r[3], r[4], r[5], r[6]]);
    let flags = r[7];
    if flags & !(F_BINDING | F_UNRESOLVED | F_MUTED) != 0 || r[8] > 100 {
        return None;
    }
    let unresolved = if flags & F_UNRESOLVED != 0 {
        let purpose = Purpose::from_u8(r[9])?;
        let mut attempt = [0u8; 16];
        attempt.copy_from_slice(&r[10..26]);
        Some(Unresolved { attempt, purpose })
    } else {
        None
    };
    Some((seq, Persisted { has_binding: flags & F_BINDING != 0, unresolved, volume: r[8], muted: flags & F_MUTED != 0 }))
}

/// `a` is newer than `b` (sequence numbers wrap).
fn newer(a: u32, b: u32) -> bool {
    (a.wrapping_sub(b) as i32) > 0
}

pub struct Storage<S: SlotStore> {
    store: S,
    state: Persisted,
    /// Which slot holds the newest valid record, and its sequence number (`None` before anything valid was found or written).
    current: Option<(usize, u32)>,
}

impl<S: SlotStore> Storage<S> {
    /// Read both slots and keep the newest valid record; with none (first boot, or both damaged) the state is the default, unbound.
    pub fn load(store: S) -> Self {
        let mut best: Option<(usize, u32, Persisted)> = None;
        for slot in 0..SLOT_COUNT {
            if let Some((seq, p)) = decode(&store.read(slot)) {
                if best.map_or(true, |(_, bs, _)| newer(seq, bs)) {
                    best = Some((slot, seq, p));
                }
            }
        }
        match best {
            Some((slot, seq, p)) => Storage { store, state: p, current: Some((slot, seq)) },
            None => Storage { store, state: Persisted::default(), current: None },
        }
    }

    pub fn state(&self) -> Persisted {
        self.state
    }
    pub fn store(&self) -> &S {
        &self.store
    }

    /// The controller's boot input, built from what was stored.
    pub fn boot_input(&self, usb_power: bool) -> Input<'static> {
        Input::Boot { has_binding: self.state.has_binding, usb_power, unresolved: self.state.unresolved }
    }

    /// Save `next` unless it equals what is stored. On a failed write the old record stays authoritative (the in-memory state is unchanged).
    pub fn save(&mut self, next: Persisted) -> Result<(), StoreError> {
        if next == self.state && self.current.is_some() {
            return Ok(());
        }
        let (slot, seq) = match self.current {
            Some((slot, seq)) => ((slot + 1) % SLOT_COUNT, seq.wrapping_add(1)),
            None => (0, 1),
        };
        self.store.write(slot, &encode(seq, &next))?;
        self.state = next;
        self.current = Some((slot, seq));
        Ok(())
    }

    /// Carry out the controller's persistence actions; any other action is ignored. Returns whether a write was attempted and failed.
    pub fn apply(&mut self, action: &Action) -> Result<(), StoreError> {
        let mut next = self.state;
        match action {
            Action::SaveBinding => next.has_binding = true,
            Action::ClearBinding => {
                // Unbinding also clears merchant settings; device identity is not stored here, so nothing else to keep.
                next = Persisted::default();
            }
            Action::PersistUnresolved(u) => next.unresolved = *u,
            Action::SetVolume { volume, muted } => {
                next.volume = (*volume).min(100);
                next.muted = *muted;
            }
            _ => return Ok(()),
        }
        self.save(next)
    }
}

/// An in-memory store for tests that can simulate losing power part-way through a write.
#[derive(Clone)]
pub struct MemStore {
    pub slots: [[u8; RECORD_LEN]; SLOT_COUNT],
    /// When set, the next write stores only this many bytes of the new record over the old bytes, then "loses power" (the write errors).
    pub tear_next_write_at: Option<usize>,
    pub writes: usize,
}

impl MemStore {
    pub fn blank() -> Self {
        MemStore { slots: [[0xFF; RECORD_LEN]; SLOT_COUNT], tear_next_write_at: None, writes: 0 }
    }
}

impl SlotStore for MemStore {
    fn read(&self, slot: usize) -> [u8; RECORD_LEN] {
        self.slots[slot]
    }
    fn write(&mut self, slot: usize, bytes: &[u8; RECORD_LEN]) -> Result<(), StoreError> {
        if let Some(n) = self.tear_next_write_at.take() {
            // Flash erases the sector first (all ones), then programs forwards: a cut leaves a prefix of the new data.
            let mut torn = [0xFF; RECORD_LEN];
            torn[..n.min(RECORD_LEN)].copy_from_slice(&bytes[..n.min(RECORD_LEN)]);
            self.slots[slot] = torn;
            return Err(StoreError::Write);
        }
        self.slots[slot] = *bytes;
        self.writes += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::controller::{Controller, Phase};

    const U: Unresolved = Unresolved { attempt: [7; 16], purpose: Purpose::Payment };

    fn bound() -> Persisted {
        Persisted { has_binding: true, ..Persisted::default() }
    }

    #[test]
    fn a_blank_device_loads_the_default_unbound_state() {
        let s = Storage::load(MemStore::blank());
        assert_eq!(s.state(), Persisted::default());
        assert!(!s.state().has_binding);
        assert_eq!(s.state().volume, DEFAULT_VOLUME_PERCENT);
    }

    #[test]
    fn a_record_round_trips_every_field() {
        let p = Persisted { has_binding: true, unresolved: Some(U), volume: 35, muted: true };
        assert_eq!(decode(&encode(9, &p)), Some((9, p)));
        let q = Persisted { has_binding: false, unresolved: None, volume: 0, muted: false };
        assert_eq!(decode(&encode(u32::MAX, &q)), Some((u32::MAX, q)));
    }

    #[test]
    fn saved_state_survives_a_reload_and_alternates_slots() {
        let mut s = Storage::load(MemStore::blank());
        s.save(bound()).unwrap();
        s.save(Persisted { unresolved: Some(U), ..bound() }).unwrap();
        s.save(Persisted { unresolved: None, ..bound() }).unwrap();
        let store = s.store().clone();
        let again = Storage::load(store);
        assert_eq!(again.state(), bound());
        assert_ne!(again.store().slots[0], again.store().slots[1]);   // both slots hold a (different) valid record
    }

    #[test]
    fn identical_state_is_not_written_again() {
        let mut s = Storage::load(MemStore::blank());
        s.save(bound()).unwrap();
        let writes = s.store().writes;
        s.save(bound()).unwrap();
        s.apply(&Action::SaveBinding).unwrap();
        assert_eq!(s.store().writes, writes);
    }

    #[test]
    fn losing_power_mid_write_leaves_the_old_value_at_every_cut_point() {
        for cut in 0..=RECORD_LEN {
            let mut s = Storage::load(MemStore::blank());
            s.save(bound()).unwrap();                                      // the old, good state
            let new = Persisted { unresolved: Some(U), ..bound() };
            let mut store = s.store().clone();
            store.tear_next_write_at = Some(cut);
            let mut s2 = Storage::load(store);
            assert!(s2.save(new).is_err());
            assert_eq!(s2.state(), bound());                               // in memory: unchanged
            let after = Storage::load(s2.store().clone());                 // after the reboot
            // A cut before the record is complete can never produce the new state; the old one is what is found. (A "cut" that wrote all
            // 28 bytes is a complete write that reported an error: the new state is then valid on disk and either answer is consistent.)
            if cut < RECORD_LEN {
                assert_eq!(after.state(), bound(), "cut at {}", cut);
            } else {
                assert!(after.state() == bound() || after.state() == new);
            }
        }
    }

    #[test]
    fn a_torn_write_over_a_blank_device_loads_as_unbound() {
        let mut store = MemStore::blank();
        store.tear_next_write_at = Some(14);
        let mut s = Storage::load(store);
        assert!(s.save(bound()).is_err());
        let after = Storage::load(s.store().clone());
        assert_eq!(after.state(), Persisted::default());
    }

    #[test]
    fn the_next_save_after_a_failed_write_still_works() {
        let mut s = Storage::load(MemStore::blank());
        s.save(bound()).unwrap();
        let mut store = s.store().clone();
        store.tear_next_write_at = Some(5);
        let mut s = Storage::load(store);
        assert!(s.save(Persisted { volume: 20, ..bound() }).is_err());
        s.save(Persisted { volume: 20, ..bound() }).unwrap();             // retried: lands in the damaged slot, over it
        assert_eq!(Storage::load(s.store().clone()).state().volume, 20);
    }

    #[test]
    fn corrupt_or_foreign_records_are_ignored() {
        let mut s = Storage::load(MemStore::blank());
        s.save(bound()).unwrap();
        s.save(Persisted { volume: 40, ..bound() }).unwrap();
        let mut store = s.store().clone();
        // Flip a bit in whichever slot is newest: the loader falls back to the older valid one.
        let newest = if decode(&store.slots[0]).unwrap().0 > decode(&store.slots[1]).unwrap().0 { 0 } else { 1 };
        store.slots[newest][8] ^= 0x01;
        assert_eq!(Storage::load(store.clone()).state(), bound());
        store.slots[1 - newest][3] ^= 0x01;                                // both damaged: unbound default, never a guess
        assert_eq!(Storage::load(store).state(), Persisted::default());
    }

    #[test]
    fn sequence_numbers_wrap_and_the_newest_still_wins() {
        let mut store = MemStore::blank();
        store.slots[0] = encode(u32::MAX, &bound());
        store.slots[1] = encode(0, &Persisted { volume: 10, ..bound() });  // newer: the counter wrapped
        let s = Storage::load(store);
        assert_eq!(s.state().volume, 10);
        let mut s = s;
        s.save(Persisted { volume: 11, ..bound() }).unwrap();
        assert_eq!(Storage::load(s.store().clone()).state().volume, 11);
    }

    #[test]
    fn out_of_range_or_unknown_flag_values_are_rejected() {
        let mut r = encode(1, &bound());
        r[8] = 101;
        let crc = crc16(&r[..26]).to_be_bytes();
        r[26..28].copy_from_slice(&crc);
        assert!(decode(&r).is_none());
        let mut r = encode(1, &bound());
        r[7] |= 0x80;
        let crc = crc16(&r[..26]).to_be_bytes();
        r[26..28].copy_from_slice(&crc);
        assert!(decode(&r).is_none());
    }

    #[test]
    fn controller_actions_map_to_stored_state() {
        let mut s = Storage::load(MemStore::blank());
        s.apply(&Action::SaveBinding).unwrap();
        assert!(s.state().has_binding);
        s.apply(&Action::PersistUnresolved(Some(U))).unwrap();
        assert_eq!(s.state().unresolved, Some(U));
        s.apply(&Action::SetVolume { volume: 30, muted: true }).unwrap();
        assert_eq!((s.state().volume, s.state().muted), (30, true));
        s.apply(&Action::SetVolume { volume: 200, muted: false }).unwrap();
        assert_eq!(s.state().volume, 100);
        s.apply(&Action::PersistUnresolved(None)).unwrap();
        assert_eq!(s.state().unresolved, None);
        s.apply(&Action::NfcStop).unwrap();                                // not a storage action
        s.apply(&Action::ClearBinding).unwrap();
        assert_eq!(s.state(), Persisted::default());                       // unbound, volume back to default, no unresolved attempt
    }

    #[test]
    fn a_stored_binding_and_unresolved_attempt_drive_the_controller_boot() {
        let mut s = Storage::load(MemStore::blank());
        s.apply(&Action::SaveBinding).unwrap();
        s.apply(&Action::PersistUnresolved(Some(U))).unwrap();
        let reloaded = Storage::load(s.store().clone());
        let mut c = Controller::new();
        c.handle(reloaded.boot_input(false), 0);
        assert!(c.has_binding());
        assert_eq!(c.unresolved(), Some(U));
        let mut fresh = Controller::new();
        fresh.handle(Storage::load(MemStore::blank()).boot_input(false), 0);
        assert!(!fresh.has_binding());
        assert_eq!(fresh.phase(), Phase::Pairing);
    }
}
