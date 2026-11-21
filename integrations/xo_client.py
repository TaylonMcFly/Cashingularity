#!/usr/bin/env python3
"""
Cashingularity Python / PySide6 Desktop IPC Client (`integrations/xo_client.py`)
BCH BLAZE 2026 — Track B (Build with XO & Desktop Wallet Integration)

Security & Arithmetic Invariants:
1. Zero external pip dependencies required for core JSON-RPC 2.0 IPC (uses stdlib `urllib.request`).
2. Strictly forbids `float` for satoshi amounts (`isinstance(val, float)` raises `TypeError`);
   all satoshi values are transported as exact decimal strings (`"150000"`) and parsed into Python `int`.
3. Enforces Chipnet (`bchtest:`) prefix validation before dispatching draft payment requests.
4. Enforces human-in-the-loop confirmation (`approved_by_user=True` + `human_consent_token`)
   before `authorize_and_broadcast` can invoke `signInvitation` or `executeAction`.
"""

from __future__ import annotations

import json
from getpass import getpass
import sys
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Union

DUST_LIMIT_SATOSHIS: int = 546


class XoIpcError(RuntimeError):
    """Raised when the Cashingularity XO Sidecar Bridge returns a JSON-RPC error."""

    def __init__(self, code: int, name: str, message: str) -> None:
        super().__init__(f"[{name} ({code})] {message}")
        self.code = code
        self.name = name
        self.rpc_message = message


@dataclass(frozen=True)
class XoReceiveAddressInfo:
    network: str
    cash_address: str
    token_aware_address: str
    locking_bytecode_hex: str
    template_identifier: str


@dataclass(frozen=True)
class XoUtxoItem:
    outpoint_transaction_hash: str
    outpoint_index: int
    value_satoshis: int
    status: str
    selectable: bool
    script_hash: str
    template_identifier: str


@dataclass(frozen=True)
class XoDraftPreview:
    draft_id: str
    network: str
    recipient_cash_address: str
    amount_satoshis: int
    fee_estimate_satoshis: int
    change_satoshis: int
    change_added: bool
    ready_to_sign: bool
    human_consent_token: str


@dataclass(frozen=True)
class XoBroadcastReceipt:
    draft_id: str
    transaction_hash: str
    serialized_transaction: str
    transaction_byte_length: int
    estimated_fee_satoshis: int
    broadcasted: bool


def normalize_satoshis_to_str(amount_satoshis: Union[int, str]) -> str:
    """
    Validates that `amount_satoshis` is an exact Python `int` or decimal integer string
    (never a `float` or `bool`) and >= 546 satoshis.
    """
    if isinstance(amount_satoshis, bool) or isinstance(amount_satoshis, float):
        raise TypeError(
            "Floating-point or boolean values are forbidden for satoshi amounts; "
            "pass an exact `int` or decimal integer `str`."
        )
    if isinstance(amount_satoshis, int):
        sats_int = amount_satoshis
    elif isinstance(amount_satoshis, str):
        cleaned = amount_satoshis.strip()
        if not cleaned.isdigit():
            raise ValueError(f"Invalid satoshi integer string: {amount_satoshis!r}")
        sats_int = int(cleaned, 10)
    else:
        raise TypeError(f"Unsupported type for amount_satoshis: {type(amount_satoshis).__name__}")

    if sats_int < DUST_LIMIT_SATOSHIS:
        raise ValueError(
            f"Satoshi amount ({sats_int}) is below BCH dust limit ({DUST_LIMIT_SATOSHIS} sats)."
        )
    return str(sats_int)


class CashingularityXoClient:
    """
    Stateless JSON-RPC 2.0 client connecting Python / PySide6 desktop workflows
    to the local Cashingularity Node/TypeScript XO Sidecar Bridge (`/api/xo/rpc`).
    """

    def __init__(
        self,
        rpc_url: str = "http://localhost:3000/api/xo/rpc",
        timeout_seconds: float = 10.0,
    ) -> None:
        self.rpc_url = rpc_url
        self.timeout_seconds = timeout_seconds

    def _call_rpc(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        request_id = f"py-ipc-{uuid.uuid4().hex[:12]}"
        payload = {
            "id": request_id,
            "method": method,
            "params": params or {},
        }
        raw_bytes = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.rpc_url,
            data=raw_bytes,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
                resp_body = resp.read().decode("utf-8")
        except urllib.error.URLError as exc:
            raise ConnectionError(
                f"Failed to connect to Cashingularity XO Bridge at {self.rpc_url}: {exc}"
            ) from exc

        parsed = json.loads(resp_body)
        if "error" in parsed and parsed["error"] is not None:
            err = parsed["error"]
            raise XoIpcError(
                code=int(err.get("code", -32000)),
                name=str(err.get("name", "XoBridgeError")),
                message=str(err.get("message", "Unknown RPC error")),
            )

        result = parsed.get("result")
        if not isinstance(result, dict):
            raise RuntimeError(f"Unexpected RPC result payload from {method}: {parsed!r}")
        return result

    def open_chipnet_account(
        self,
        mnemonic: str,
        database_path: str = "./.xo-data",
        database_filename: str = "XO",
    ) -> Dict[str, Any]:
        """Opens the singleton Chipnet XO Engine account and imports audited templates."""
        words = [w for w in mnemonic.strip().split() if w]
        if len(words) not in (12, 24):
            raise ValueError("BIP39 mnemonic must contain 12 or 24 words.")
        return self._call_rpc(
            "wallet.openChipnetAccount",
            {
                "mnemonic": " ".join(words),
                "databasePath": database_path,
                "databaseFilename": database_filename,
            },
        )

    def get_network_status(self) -> Dict[str, Any]:
        """Queries Chipnet chain height and Electrum connection status."""
        return self._call_rpc("wallet.getNetworkStatus")

    def get_receive_address(self) -> XoReceiveAddressInfo:
        """Derives the Chipnet receive address (`bchtest:q...` and token-aware `bchtest:z...`)."""
        res = self._call_rpc("wallet.getReceiveAddress")
        return XoReceiveAddressInfo(
            network=str(res.get("network", "chipnet")),
            cash_address=str(res["cashAddress"]),
            token_aware_address=str(res.get("tokenAwareAddress", res["cashAddress"])),
            locking_bytecode_hex=str(res["lockingBytecodeHex"]),
            template_identifier=str(res["templateIdentifier"]),
        )

    def list_utxos(self) -> List[XoUtxoItem]:
        """Returns spendable Chipnet UTXOs with values converted to exact Python `int` satoshis."""
        res = self._call_rpc("wallet.listUtxos")
        raw_list = res.get("spendableUnspent", [])
        utxos: List[XoUtxoItem] = []
        for item in raw_list:
            utxos.append(
                XoUtxoItem(
                    outpoint_transaction_hash=str(item["outpointTransactionHash"]),
                    outpoint_index=int(item["outpointIndex"]),
                    value_satoshis=int(str(item["valueSatoshis"]), 10),
                    status=str(item.get("status", "unspent")),
                    selectable=bool(item.get("selectable", True)),
                    script_hash=str(item["scriptHash"]),
                    template_identifier=str(item["templateIdentifier"]),
                )
            )
        return utxos

    def create_draft_payment(
        self,
        recipient_cash_address: str,
        amount_satoshis: Union[int, str],
    ) -> Dict[str, Any]:
        """Creates an unsigned XO payment invitation (`sendSatoshis`) on Chipnet."""
        addr = recipient_cash_address.strip()
        if not addr.lower().startswith("bchtest:"):
            raise ValueError(
                f"Chipnet safety guard: expected 'bchtest:' address prefix, got {addr!r}"
            )
        amount_str = normalize_satoshis_to_str(amount_satoshis)
        return self._call_rpc(
            "wallet.createDraftPayment",
            {
                "recipientCashAddress": addr,
                "amountSatoshis": amount_str,
            },
        )

    def preview_payment(self, draft_id: str) -> XoDraftPreview:
        """
        Calculates change and fee, calls `addChangeToInvitation` strictly BEFORE signing,
        and returns a `human_consent_token` for explicit user approval.
        """
        res = self._call_rpc("wallet.previewPayment", {"draftId": draft_id.strip()})
        return XoDraftPreview(
            draft_id=str(res["draftId"]),
            network=str(res["network"]),
            recipient_cash_address=str(res["recipientCashAddress"]),
            amount_satoshis=int(str(res["amountSatoshis"]), 10),
            fee_estimate_satoshis=int(str(res["feeEstimateSatoshis"]), 10),
            change_satoshis=int(str(res["changeSatoshis"]), 10),
            change_added=bool(res["changeAdded"]),
            ready_to_sign=bool(res["readyToSign"]),
            human_consent_token=str(res["humanConsentToken"]),
        )

    def authorize_and_broadcast(
        self,
        draft_id: str,
        human_consent_token: str,
        approved_by_user: bool,
        broadcast_transaction: bool = True,
    ) -> XoBroadcastReceipt:
        """
        Signs and executes the XO invitation ONLY when `approved_by_user=True` and a valid
        `human_consent_token` from `preview_payment` is provided.
        """
        if not approved_by_user:
            raise PermissionError(
                "User rejected transaction confirmation; signing and broadcast aborted."
            )
        if not human_consent_token or not human_consent_token.startswith("consent-"):
            raise PermissionError("Valid human_consent_token from preview_payment is required.")

        res = self._call_rpc(
            "wallet.authorizeAndBroadcast",
            {
                "draftId": draft_id.strip(),
                "humanConsentToken": human_consent_token.strip(),
                "approvedByUser": True,
                "broadcastTransaction": bool(broadcast_transaction),
            },
        )
        return XoBroadcastReceipt(
            draft_id=str(res["draftId"]),
            transaction_hash=str(res["transactionHash"]),
            serialized_transaction=str(res["serializedTransaction"]),
            transaction_byte_length=int(res["transactionByteLength"]),
            estimated_fee_satoshis=int(str(res["estimatedFeeSatoshis"]), 10),
            broadcasted=bool(res["broadcasted"]),
        )


def _run_cli_self_test() -> int:
    print("====================================================================")
    print(" Cashingularity Python IPC Client (`integrations/xo_client.py`) Test")
    print("====================================================================")
    client = CashingularityXoClient()

    # 1. Verify float rejection guard
    try:
        normalize_satoshis_to_str(1500.5)  # type: ignore[arg-type]
        raise AssertionError("Float satoshi amount should have raised TypeError")
    except TypeError:
        print("[PASS] Float precision guard rejected float satoshi input.")

    # 2. Open Chipnet Account
    mnemonic = getpass("Recovery phrase for the disposable Chipnet sidecar wallet: ")
    if not mnemonic.strip():
        raise SystemExit("A dedicated Chipnet wallet is required.")
    acct = client.open_chipnet_account(mnemonic)
    print(f"[PASS] open_chipnet_account -> network={acct['network']}, status={acct['bridgeStatus']}")

    # 3. Network status & receive address
    status = client.get_network_status()
    addr_info = client.get_receive_address()
    print(
        f"[PASS] get_receive_address  -> {addr_info.cash_address} "
        f"(token-aware: {addr_info.token_aware_address})"
    )
    print(f"[PASS] get_network_status   -> height={status['chainStatus']['height']}")

    # 4. List UTXOs
    utxos = client.list_utxos()
    print(f"[PASS] list_utxos           -> {len(utxos)} spendable UTXO(s), value={utxos[0].value_satoshis} sats")

    # 5. Create Draft -> Preview (addChangeToInvitation before sign) -> Authorize & Broadcast
    draft = client.create_draft_payment(
        recipient_cash_address=addr_info.cash_address,
        amount_satoshis=25000,
    )
    preview = client.preview_payment(draft["draftId"])
    print(
        f"[PASS] preview_payment      -> draft={preview.draft_id}, "
        f"amount={preview.amount_satoshis} sats, fee={preview.fee_estimate_satoshis} sats, "
        f"change={preview.change_satoshis} sats (changeAdded={preview.change_added})"
    )

    receipt = client.authorize_and_broadcast(
        draft_id=preview.draft_id,
        human_consent_token=preview.human_consent_token,
        approved_by_user=True,
        broadcast_transaction=False,
    )
    print(f"[PASS] authorize_and_broadcast -> txid={receipt.transaction_hash}")
    return 0


if __name__ == "__main__":
    sys.exit(_run_cli_self_test())
