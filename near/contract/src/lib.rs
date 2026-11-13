use near_sdk::store::{LookupMap, UnorderedMap};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct AuctionRecord { pub request_hash: String, pub winner_id: String, pub total_amount: u64, pub created_at: u64 }

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct BidCommitment { pub seller_id: AccountId, pub commitment: String, pub unit_price: Option<u64>, pub quantity: Option<u64>, pub revealed: bool }

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct EscrowEntry { pub auction_id: String, pub buyer_id: AccountId, pub amount: u128, pub status: String }

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Registry { owner: AccountId, records: LookupMap<String, AuctionRecord>, commitments: UnorderedMap<String, BidCommitment>, escrows: UnorderedMap<String, EscrowEntry> }

fn commitment_hash(auction_id: &str, seller_id: &AccountId, unit_price: u64, quantity: u64, salt: &str) -> String {
    let input = format!("{auction_id}|{seller_id}|{unit_price}|{quantity}|{salt}");
    env::sha256(input.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner: AccountId) -> Self { Self { owner, records: LookupMap::new(b"r"), commitments: UnorderedMap::new(b"c"), escrows: UnorderedMap::new(b"e") } }

    /// Sellers publish only a SHA-256 commitment; price and quantity stay hidden until reveal.
    pub fn commit_bid(&mut self, auction_id: String, commitment: String) {
        let seller_id = env::predecessor_account_id();
        require!(!auction_id.is_empty() && auction_id.len() <= 64, "invalid auction_id");
        require!(commitment.len() == 64 && commitment.chars().all(|c| c.is_ascii_hexdigit()), "commitment must be a 64-character hex SHA-256");
        let key = format!("{auction_id}:{seller_id}");
        require!(!self.commitments.contains_key(&key), "seller already committed");
        self.commitments.insert(key, BidCommitment { seller_id, commitment: commitment.to_lowercase(), unit_price: None, quantity: None, revealed: false });
    }

    /// The seller reveals the values; the contract rejects any mismatch with the commitment.
    pub fn reveal_bid(&mut self, auction_id: String, unit_price: u64, quantity: u64, salt: String) {
        let seller_id = env::predecessor_account_id();
        let key = format!("{auction_id}:{seller_id}");
        let mut bid = self.commitments.get(&key).cloned().unwrap_or_else(|| env::panic_str("no commitment for seller"));
        require!(!bid.revealed, "bid already revealed");
        require!(commitment_hash(&auction_id, &seller_id, unit_price, quantity, &salt) == bid.commitment, "reveal does not match commitment");
        bid.unit_price = Some(unit_price); bid.quantity = Some(quantity); bid.revealed = true;
        self.commitments.insert(key, bid);
    }

    pub fn get_bid(&self, auction_id: String, seller_id: AccountId) -> Option<BidCommitment> { self.commitments.get(&format!("{auction_id}:{seller_id}")).cloned() }

    /// Buyer deposits testnet NEAR. Deposits are keyed by auction and buyer and cannot be overwritten.
    #[payable]
    pub fn deposit_escrow(&mut self, auction_id: String) {
        let buyer_id = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(!auction_id.is_empty() && auction_id.len() <= 64, "invalid auction_id");
        require!(amount > 0, "deposit must be greater than zero");
        let key = format!("{auction_id}:{buyer_id}");
        require!(!self.escrows.contains_key(&key), "buyer already deposited for this auction");
        self.escrows.insert(key, EscrowEntry { auction_id, buyer_id, amount, status: "open".into() });
    }

    pub fn get_escrow(&self, auction_id: String, buyer_id: AccountId) -> Option<EscrowEntry> { self.escrows.get(&format!("{auction_id}:{buyer_id}")).cloned() }

    /// Owner confirms delivery and releases every open buyer deposit to the winning seller.
    pub fn confirm_delivery(&mut self, auction_id: String, seller_id: AccountId) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can confirm delivery");
        let mut total = 0u128;
        let mut keys = Vec::new();
        for (key, entry) in self.escrows.iter() {
            if entry.auction_id == auction_id && entry.status == "open" { total += entry.amount; keys.push(key.clone()); }
        }
        require!(total > 0, "no open deposits for this auction");
        for key in keys { self.escrows.remove(&key); }
        Promise::new(seller_id).transfer(NearToken::from_yoctonear(total))
    }

    /// Owner refunds every open buyer deposit when delivery fails or the auction is cancelled.
    pub fn refund_escrow(&mut self, auction_id: String) -> Vec<Promise> {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can refund escrow");
        let mut refunds = Vec::new();
        let mut keys = Vec::new();
        for (key, entry) in self.escrows.iter() {
            if entry.auction_id == auction_id && entry.status == "open" { refunds.push(Promise::new(entry.buyer_id.clone()).transfer(NearToken::from_yoctonear(entry.amount))); keys.push(key.clone()); }
        }
        require!(!refunds.is_empty(), "no open deposits for this auction");
        for key in keys { self.escrows.remove(&key); }
        refunds
    }

    /// The auctioneer's selected winner remains owner-authorized and write-once.
    pub fn record_auction(&mut self, request_id: String, request_hash: String, winner_id: String, total_amount: u64) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can record auctions");
        require!(!request_id.is_empty() && request_id.len() <= 64, "request_id must be 1-64 characters");
        require!(request_hash.len() == 64 && request_hash.chars().all(|c| c.is_ascii_hexdigit()), "request_hash must be a 64-character hex SHA-256");
        require!(!winner_id.is_empty() && winner_id.len() <= 64, "winner_id must be 1-64 characters");
        require!(!self.records.contains_key(&request_id), "A record for this request_id already exists");
        self.records.insert(request_id, AuctionRecord { request_hash, winner_id, total_amount, created_at: env::block_timestamp() });
    }

    pub fn get_record(&self, request_id: String) -> Option<AuctionRecord> { self.records.get(&request_id).cloned() }
    pub fn get_owner(&self) -> AccountId { self.owner.clone() }
}

#[cfg(test)]
mod tests {
    use super::*; use near_sdk::test_utils::VMContextBuilder; use near_sdk::testing_env;
    fn acct(name: &str) -> AccountId { name.parse().unwrap() }
    fn as_account(name: &str) { testing_env!(VMContextBuilder::new().predecessor_account_id(acct(name)).build()); }
    #[test]
    fn seller_can_commit_and_reveal_matching_bid() {
        as_account("backend.testnet"); let mut c = Registry::new(acct("backend.testnet"));
        let seller = acct("seller-river.testnet"); let salt = "secret";
        let hash = commitment_hash("auction-1", &seller, 41000, 100, salt);
        as_account("seller-river.testnet"); c.commit_bid("auction-1".into(), hash);
        c.reveal_bid("auction-1".into(), 41000, 100, salt.into());
        assert!(c.get_bid("auction-1".into(), seller).unwrap().revealed);
    }
}
