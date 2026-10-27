// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Stub contract — satisfies TripSharedTreasuryV2.t.sol compilation only.
contract TripSharedTreasuryV2 {
    using SafeERC20 for IERC20;

    enum SettlementStatus { None, Proposed, DeficitPaying, ClaimStarted, Completed }

    error NotAdmin(uint256 tripId);
    error NotParticipant(uint256 tripId);
    error AlreadyParticipant(address addr);
    error InvalidAmount();
    error InsufficientContractBalance(uint256 available, uint256 requested);
    error ExceedsAllocated(uint256 allocated, uint256 requested);
    error ExceedsRequiredDeficit(uint256 required, uint256 paid, uint256 attempted);
    error NotAllApproved();
    error DeficitNotFullyPaid();
    error BalanceMismatch(uint256 contractBalance, uint256 expectedForRefunds);
    error AlreadyClaimed();
    error NoSettlementProposed();
    error ArrayLengthMismatch();
    error ZeroAddress();
    error SpenderNotParticipant(address spender);
    error TripLocked(uint256 tripId);
    error SettlementAlreadyInProgress(SettlementStatus current);
    error InvalidSettlementHash(bytes32 expected, bytes32 provided);
    error SpendAmountExceedsAllocated(uint256 allocated, uint256 alreadySpent, uint256 requested);

    event TripCreated(uint256 indexed tripId, address indexed admin, string name, uint256 targetBudget);
    event Deposited(uint256 indexed tripId, address indexed participant, uint256 amount);
    event BudgetReleased(uint256 indexed tripId, address indexed spender, uint256 amount, string memo);
    event BudgetReturned(uint256 indexed tripId, address indexed returner, uint256 amount);
    event DeficitPaid(uint256 indexed tripId, address indexed payer, uint256 amount);
    event SettlementApproved(uint256 indexed tripId, address indexed participant, bytes32 indexed ledgerHash);
    event RefundClaimed(uint256 indexed tripId, address indexed participant, uint256 amount);
    event ActualSpendRecorded(uint256 indexed tripId, address indexed spender, uint256 amount, string memo);
    event PersonalPrepaidRecorded(uint256 indexed tripId, address indexed payer, uint256 amount, string memo);
    event TripCompleted(uint256 indexed tripId);

    struct TripData {
        string name;
        address admin;
        address[] participants;
        uint256 targetBudget;
        bool exists;
        bool locked;
        SettlementStatus settlementStatus;
        uint256 settlementVersion;
        bytes32 pendingSettlementHash;
        address[] settlementMembers;
        uint256[] finalRefundAmounts;
        uint256[] requiredDeficits;
    }

    mapping(uint256 => TripData) internal _trips;
    mapping(uint256 => mapping(address => uint256)) public depositedAmount;
    mapping(uint256 => mapping(address => uint256)) public allocatedBudget;
    mapping(uint256 => mapping(address => uint256)) public spentFromBudget;
    mapping(uint256 => mapping(address => uint256)) public personalPrepaid;
    mapping(uint256 => mapping(address => bool))    public settlementApproved;
    mapping(uint256 => mapping(address => uint256)) public paidDeficit;
    mapping(uint256 => mapping(address => bool))    public refundClaimed;
    mapping(uint256 => mapping(address => bool))    public isParticipant;
    mapping(uint256 => uint256) public tripBalance;
    mapping(uint256 => uint256) public settlementTotalRefunds;
    uint256 public tripCount;
    IERC20 public immutable usdc;

    constructor(address usdcToken) {
        if (usdcToken == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcToken);
    }

    function createTrip(string calldata name, address[] calldata participants, uint256 targetBudget)
        external returns (uint256 tripId)
    {
        tripCount += 1;
        tripId = tripCount;
        TripData storage t = _trips[tripId];
        t.name = name; t.admin = msg.sender; t.targetBudget = targetBudget; t.exists = true;
        isParticipant[tripId][msg.sender] = true;
        t.participants.push(msg.sender);
        for (uint256 i = 0; i < participants.length; i++) {
            address p = participants[i];
            if (p == address(0)) revert ZeroAddress();
            if (isParticipant[tripId][p]) revert AlreadyParticipant(p);
            isParticipant[tripId][p] = true;
            t.participants.push(p);
        }
        emit TripCreated(tripId, msg.sender, name, targetBudget);
    }

    function deposit(uint256 tripId, uint256 amount) external {
        TripData storage t = _trips[tripId];
        if (!t.exists) revert NotParticipant(tripId);
        if (!isParticipant[tripId][msg.sender]) revert NotParticipant(tripId);
        if (t.locked) revert TripLocked(tripId);
        SettlementStatus s = t.settlementStatus;
        if (s == SettlementStatus.DeficitPaying || s == SettlementStatus.ClaimStarted || s == SettlementStatus.Completed)
            revert SettlementAlreadyInProgress(s);
        if (amount == 0) revert InvalidAmount();
        depositedAmount[tripId][msg.sender] += amount;
        tripBalance[tripId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(tripId, msg.sender, amount);
    }

    function releaseBudget(uint256 tripId, address spender, uint256 amount, string calldata memo) external {
        TripData storage t = _trips[tripId];
        if (!t.exists) revert NotAdmin(tripId);
        if (msg.sender != t.admin) revert NotAdmin(tripId);
        SettlementStatus s = t.settlementStatus;
        if (s != SettlementStatus.None) revert SettlementAlreadyInProgress(s);
        if (t.locked) revert TripLocked(tripId);
        if (!isParticipant[tripId][spender]) revert SpenderNotParticipant(spender);
        if (amount == 0) revert InvalidAmount();
        uint256 bal = tripBalance[tripId];
        if (bal < amount) revert InsufficientContractBalance(bal, amount);
        allocatedBudget[tripId][spender] += amount;
        tripBalance[tripId] = bal - amount;
        usdc.safeTransfer(spender, amount);
        emit BudgetReleased(tripId, spender, amount, memo);
    }

    function returnUnusedBudget(uint256 tripId, uint256 amount) external {
        TripData storage t = _trips[tripId];
        if (!t.exists) revert NotParticipant(tripId);
        if (amount == 0) revert InvalidAmount();
        uint256 allocated = allocatedBudget[tripId][msg.sender];
        if (amount > allocated) revert ExceedsAllocated(allocated, amount);
        allocatedBudget[tripId][msg.sender] = allocated - amount;
        tripBalance[tripId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BudgetReturned(tripId, msg.sender, amount);
    }

    function recordActualSpend(uint256 tripId, uint256 amount, string calldata memo) external {
        if (amount == 0) revert InvalidAmount();
        uint256 allocated = allocatedBudget[tripId][msg.sender];
        uint256 alreadySpent = spentFromBudget[tripId][msg.sender];
        if (alreadySpent + amount > allocated) revert SpendAmountExceedsAllocated(allocated, alreadySpent, amount);
        spentFromBudget[tripId][msg.sender] = alreadySpent + amount;
        emit ActualSpendRecorded(tripId, msg.sender, amount, memo);
    }

    function recordPersonalPrepaid(uint256 tripId, uint256 amount, string calldata memo) external {
        if (!isParticipant[tripId][msg.sender]) revert NotParticipant(tripId);
        if (amount == 0) revert InvalidAmount();
        personalPrepaid[tripId][msg.sender] += amount;
        emit PersonalPrepaidRecorded(tripId, msg.sender, amount, memo);
    }

    function proposeFinalSettlement(uint256 tripId, address[] calldata members, uint256[] calldata refunds, uint256[] calldata deficits) external {
        if (members.length != refunds.length || members.length != deficits.length) revert ArrayLengthMismatch();
        TripData storage t = _trips[tripId];
        if (!t.exists) revert NotAdmin(tripId);
        if (msg.sender != t.admin) revert NotAdmin(tripId);
        SettlementStatus s = t.settlementStatus;
        if (s >= SettlementStatus.DeficitPaying) revert SettlementAlreadyInProgress(s);
        if (members.length != t.participants.length) revert ArrayLengthMismatch();
        uint256 newVersion = t.settlementVersion + 1;
        bytes32 h = keccak256(abi.encode(tripId, newVersion, members, refunds, deficits));
        t.pendingSettlementHash = h;
        t.settlementMembers = members;
        t.finalRefundAmounts = refunds;
        t.requiredDeficits = deficits;
        t.settlementVersion = newVersion;
        t.settlementStatus = SettlementStatus.Proposed;
        uint256 total = 0;
        for (uint256 i = 0; i < members.length; i++) {
            total += refunds[i];
            settlementApproved[tripId][members[i]] = false;
            refundClaimed[tripId][members[i]] = false;
            paidDeficit[tripId][members[i]] = 0;
        }
        settlementTotalRefunds[tripId] = total;
    }

    function payDeficit(uint256 tripId, uint256 amount) external {
        TripData storage t = _trips[tripId];
        if (!t.exists) revert NotParticipant(tripId);
        if (!isParticipant[tripId][msg.sender]) revert NotParticipant(tripId);
        if (amount == 0) revert InvalidAmount();
        if (t.settlementStatus == SettlementStatus.None) revert NoSettlementProposed();
        uint256 idx = 0; bool found = false;
        for (uint256 i = 0; i < t.settlementMembers.length; i++) {
            if (t.settlementMembers[i] == msg.sender) { idx = i; found = true; break; }
        }
        if (!found) revert NotParticipant(tripId);
        uint256 required = t.requiredDeficits[idx];
        uint256 paid = paidDeficit[tripId][msg.sender];
        if (paid + amount > required) revert ExceedsRequiredDeficit(required, paid, amount);
        paidDeficit[tripId][msg.sender] = paid + amount;
        tripBalance[tripId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (t.settlementStatus == SettlementStatus.Proposed) t.settlementStatus = SettlementStatus.DeficitPaying;
    }

    function approveFinalSettlement(uint256 tripId, bytes32 ledgerHash) external {
        TripData storage t = _trips[tripId];
        if (!t.exists) revert NotParticipant(tripId);
        if (!isParticipant[tripId][msg.sender]) revert NotParticipant(tripId);
        if (t.settlementStatus == SettlementStatus.None) revert NoSettlementProposed();
        if (ledgerHash != t.pendingSettlementHash) revert InvalidSettlementHash(t.pendingSettlementHash, ledgerHash);
        settlementApproved[tripId][msg.sender] = true;
        emit SettlementApproved(tripId, msg.sender, ledgerHash);
    }

    function claimRefund(uint256 tripId) external {
        TripData storage t = _trips[tripId];
        if (!t.exists) revert NotParticipant(tripId);
        if (t.locked) revert TripLocked(tripId);
        if (!isParticipant[tripId][msg.sender]) revert NotParticipant(tripId);
        if (t.settlementStatus == SettlementStatus.None) revert NoSettlementProposed();
        if (refundClaimed[tripId][msg.sender]) revert AlreadyClaimed();
        for (uint256 i = 0; i < t.settlementMembers.length; i++) {
            if (!settlementApproved[tripId][t.settlementMembers[i]]) revert NotAllApproved();
            if (paidDeficit[tripId][t.settlementMembers[i]] != t.requiredDeficits[i]) revert DeficitNotFullyPaid();
        }
        uint256 idx = 0;
        for (uint256 i = 0; i < t.settlementMembers.length; i++) {
            if (t.settlementMembers[i] == msg.sender) { idx = i; break; }
        }
        uint256 refundAmt = t.finalRefundAmounts[idx];
        refundClaimed[tripId][msg.sender] = true;
        if (refundAmt > 0) {
            tripBalance[tripId] -= refundAmt;
            usdc.safeTransfer(msg.sender, refundAmt);
        }
        emit RefundClaimed(tripId, msg.sender, refundAmt);
        bool allClaimed = true;
        for (uint256 i = 0; i < t.settlementMembers.length; i++) {
            if (!refundClaimed[tripId][t.settlementMembers[i]]) { allClaimed = false; break; }
        }
        if (allClaimed) {
            t.locked = true;
            t.settlementStatus = SettlementStatus.Completed;
            emit TripCompleted(tripId);
        }
    }

    function getSettlementStatus(uint256 tripId) external view returns (SettlementStatus) {
        return _trips[tripId].settlementStatus;
    }

    function getSettlementVersion(uint256 tripId) external view returns (uint256) {
        return _trips[tripId].settlementVersion;
    }

    function getPersonalPrepaid(uint256 tripId, address payer) external view returns (uint256) {
        return personalPrepaid[tripId][payer];
    }
}
