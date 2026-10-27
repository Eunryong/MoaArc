// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Stub contract — satisfies TripSharedTreasury.t.sol compilation only.
contract TripSharedTreasury {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_PARTICIPANTS = 50;

    struct Trip {
        string name;
        address admin;
        address[] participants;
        uint256 targetBudget;
        bool exists;
        bool locked;
    }

    error TripNotFound(uint256 tripId);
    error NotAdmin(uint256 tripId);
    error NotParticipant(uint256 tripId);
    error AlreadyParticipant(address addr);
    error InvalidAmount();
    error InsufficientContractBalance(uint256 available, uint256 requested);
    error ExceedsAllocated(uint256 allocated, uint256 requested);
    error ExceedsRequiredDeficit(uint256 required, uint256 paid, uint256 attempted);
    error SettlementHashMismatch(bytes32 expected, bytes32 provided);
    error NotAllApproved();
    error DeficitNotFullyPaid();
    error BalanceMismatch(uint256 contractBalance, uint256 expectedForRefunds);
    error AlreadyClaimed();
    error NoSettlementProposed();
    error ArrayLengthMismatch();
    error ZeroAddress();
    error InvalidSettlementMembers();
    error SpenderNotParticipant(address spender);
    error TooManyParticipants(uint256 max, uint256 provided);

    event TripCreated(uint256 indexed tripId, address indexed admin, string name, uint256 targetBudget);
    event Deposited(uint256 indexed tripId, address indexed participant, uint256 amount);
    event BudgetReleased(uint256 indexed tripId, address indexed spender, uint256 amount, string memo);
    event BudgetReturned(uint256 indexed tripId, address indexed returner, uint256 amount);
    event DeficitPaid(uint256 indexed tripId, address indexed payer, uint256 amount);
    event SettlementProposed(uint256 indexed tripId, bytes32 indexed ledgerHash, address[] members, uint256[] refundAmounts, uint256[] requiredDeficits);
    event SettlementApproved(uint256 indexed tripId, address indexed participant, bytes32 indexed ledgerHash);
    event RefundClaimed(uint256 indexed tripId, address indexed participant, uint256 amount);
    event TripCompleted(uint256 indexed tripId);

    struct TripData {
        string name;
        address admin;
        address[] participants;
        uint256 targetBudget;
        bool exists;
        bool locked;
        uint256 settlementVersion;
        bytes32 pendingSettlementHash;
        address[] settlementMembers;
        uint256[] finalRefundAmounts;
        uint256[] requiredDeficits;
        uint8 settlementStatus; // 0=None,1=Proposed,2=DeficitPaying,3=ClaimStarted,4=Completed
    }

    mapping(uint256 => TripData) internal _trips;
    mapping(uint256 => mapping(address => uint256)) public depositedAmount;
    mapping(uint256 => mapping(address => uint256)) public allocatedBudget;
    mapping(uint256 => mapping(address => bool))    public settlementApproved;
    mapping(uint256 => mapping(address => uint256)) public paidDeficit;
    mapping(uint256 => mapping(address => bool))    public refundClaimed;
    mapping(uint256 => mapping(address => bool))    public isParticipant;
    mapping(uint256 => uint256) public tripBalance;
    mapping(uint256 => uint256) public claimCount;
    uint256 public tripCount;
    IERC20 public immutable usdc;

    constructor(address usdcToken) {
        if (usdcToken == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcToken);
    }

    function createTrip(string calldata name, address[] calldata participants, uint256 targetBudget)
        external returns (uint256 tripId)
    {
        uint256 total = participants.length + 1;
        if (total > MAX_PARTICIPANTS) revert TooManyParticipants(MAX_PARTICIPANTS, total);
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
        if (!t.exists) revert TripNotFound(tripId);
        if (!isParticipant[tripId][msg.sender]) revert NotParticipant(tripId);
        if (amount == 0) revert InvalidAmount();
        depositedAmount[tripId][msg.sender] += amount;
        tripBalance[tripId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(tripId, msg.sender, amount);
    }

    function releaseBudget(uint256 tripId, address spender, uint256 amount, string calldata memo) external {
        TripData storage t = _trips[tripId];
        if (!t.exists) revert TripNotFound(tripId);
        if (msg.sender != t.admin) revert NotAdmin(tripId);
        if (spender == address(0)) revert ZeroAddress();
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
        if (!t.exists) revert TripNotFound(tripId);
        if (amount == 0) revert InvalidAmount();
        uint256 allocated = allocatedBudget[tripId][msg.sender];
        if (amount > allocated) revert ExceedsAllocated(allocated, amount);
        allocatedBudget[tripId][msg.sender] = allocated - amount;
        tripBalance[tripId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BudgetReturned(tripId, msg.sender, amount);
    }

    function proposeFinalSettlement(uint256 tripId, bytes32 ledgerHash, address[] calldata members, uint256[] calldata refunds, uint256[] calldata deficits) external {
        if (members.length != refunds.length || members.length != deficits.length) revert ArrayLengthMismatch();
        TripData storage t = _trips[tripId];
        if (!t.exists) revert TripNotFound(tripId);
        if (msg.sender != t.admin) revert NotAdmin(tripId);
        if (t.settlementStatus >= 2) revert ArrayLengthMismatch(); // DeficitPaying+
        if (members.length != t.participants.length) revert ArrayLengthMismatch();
        t.pendingSettlementHash = ledgerHash;
        t.settlementMembers = members;
        t.finalRefundAmounts = refunds;
        t.requiredDeficits = deficits;
        t.settlementVersion += 1;
        t.settlementStatus = 1; // Proposed
        for (uint256 i = 0; i < members.length; i++) {
            settlementApproved[tripId][members[i]] = false;
            refundClaimed[tripId][members[i]] = false;
            paidDeficit[tripId][members[i]] = 0;
        }
        claimCount[tripId] = 0;
        emit SettlementProposed(tripId, ledgerHash, members, refunds, deficits);
    }

    function payDeficit(uint256 tripId, uint256 amount) external {
        TripData storage t = _trips[tripId];
        if (!t.exists) revert TripNotFound(tripId);
        if (!isParticipant[tripId][msg.sender]) revert NotParticipant(tripId);
        if (amount == 0) revert InvalidAmount();
        if (t.settlementStatus == 0) revert NoSettlementProposed();
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
        if (t.settlementStatus == 1) t.settlementStatus = 2; // DeficitPaying
        emit DeficitPaid(tripId, msg.sender, amount);
    }

    function approveFinalSettlement(uint256 tripId, bytes32 ledgerHash) external {
        TripData storage t = _trips[tripId];
        if (!t.exists) revert TripNotFound(tripId);
        if (!isParticipant[tripId][msg.sender]) revert NotParticipant(tripId);
        if (t.settlementStatus == 0) revert NoSettlementProposed();
        if (ledgerHash != t.pendingSettlementHash) revert SettlementHashMismatch(t.pendingSettlementHash, ledgerHash);
        settlementApproved[tripId][msg.sender] = true;
        emit SettlementApproved(tripId, msg.sender, ledgerHash);
    }

    function claimRefund(uint256 tripId) external {
        TripData storage t = _trips[tripId];
        if (!t.exists) revert TripNotFound(tripId);
        if (t.locked) revert ArrayLengthMismatch();
        if (!isParticipant[tripId][msg.sender]) revert NotParticipant(tripId);
        if (t.settlementStatus == 0) revert NoSettlementProposed();
        if (refundClaimed[tripId][msg.sender]) revert AlreadyClaimed();
        for (uint256 i = 0; i < t.settlementMembers.length; i++) {
            if (!settlementApproved[tripId][t.settlementMembers[i]]) revert NotAllApproved();
            if (paidDeficit[tripId][t.settlementMembers[i]] != t.requiredDeficits[i]) revert DeficitNotFullyPaid();
        }
        if (claimCount[tripId] == 0) {
            uint256 totalRefunds = 0;
            for (uint256 i = 0; i < t.finalRefundAmounts.length; i++) totalRefunds += t.finalRefundAmounts[i];
            if (tripBalance[tripId] != totalRefunds) revert BalanceMismatch(tripBalance[tripId], totalRefunds);
            t.settlementStatus = 3; // ClaimStarted
        }
        uint256 idx = 0;
        for (uint256 i = 0; i < t.settlementMembers.length; i++) {
            if (t.settlementMembers[i] == msg.sender) { idx = i; break; }
        }
        uint256 refundAmt = t.finalRefundAmounts[idx];
        refundClaimed[tripId][msg.sender] = true;
        claimCount[tripId] += 1;
        if (refundAmt > 0) {
            tripBalance[tripId] -= refundAmt;
            usdc.safeTransfer(msg.sender, refundAmt);
        }
        emit RefundClaimed(tripId, msg.sender, refundAmt);
        if (claimCount[tripId] == t.settlementMembers.length) {
            t.locked = true;
            t.settlementStatus = 4; // Completed
            emit TripCompleted(tripId);
        }
    }

    function getTrip(uint256 tripId) external view returns (Trip memory t) {
        TripData storage td = _trips[tripId];
        if (!td.exists) revert TripNotFound(tripId);
        t.name = td.name;
        t.admin = td.admin;
        t.participants = td.participants;
        t.targetBudget = td.targetBudget;
        t.exists = td.exists;
        t.locked = td.locked;
    }

    function getTripParticipants(uint256 tripId) external view returns (address[] memory) {
        if (!_trips[tripId].exists) revert TripNotFound(tripId);
        return _trips[tripId].participants;
    }

    function isAllApproved(uint256 tripId) external view returns (bool) {
        TripData storage t = _trips[tripId];
        if (t.settlementStatus == 0) return false;
        for (uint256 i = 0; i < t.settlementMembers.length; i++) {
            if (!settlementApproved[tripId][t.settlementMembers[i]]) return false;
        }
        return true;
    }

    function getSettlementDetails(uint256 tripId) external view returns (bytes32, address[] memory, uint256[] memory, uint256[] memory, bool) {
        TripData storage t = _trips[tripId];
        return (t.pendingSettlementHash, t.settlementMembers, t.finalRefundAmounts, t.requiredDeficits, t.settlementStatus != 0);
    }
}
