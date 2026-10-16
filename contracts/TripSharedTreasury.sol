// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract TripSharedTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Trip {
        string name;
        address admin;
        address[] participants;
        uint256 targetBudget;
        bool exists;
        // Settlement
        bytes32 pendingSettlementHash;
        address[] settlementMembers;
        uint256[] finalRefundAmounts;
        uint256[] requiredDeficits;
        bool settlementProposed;
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
    event SettlementProposed(
        uint256 indexed tripId,
        bytes32 indexed ledgerHash,
        address[] members,
        uint256[] refundAmounts,
        uint256[] requiredDeficits
    );
    event SettlementApproved(uint256 indexed tripId, address indexed participant, bytes32 indexed ledgerHash);
    event RefundClaimed(uint256 indexed tripId, address indexed participant, uint256 amount);

    mapping(uint256 => Trip) public trips;
    mapping(uint256 => mapping(address => uint256)) public depositedAmount;
    mapping(uint256 => mapping(address => uint256)) public allocatedBudget;
    mapping(uint256 => mapping(address => bool)) public settlementApproved;
    mapping(uint256 => mapping(address => uint256)) public paidDeficit;
    mapping(uint256 => mapping(address => bool)) public refundClaimed;
    mapping(uint256 => mapping(address => bool)) public isParticipant;
    mapping(uint256 => uint256) public tripBalance;
    // Set to sum(finalRefundAmounts) when settlement is proposed; used for one-time solvency check in claimRefund
    mapping(uint256 => uint256) public settlementTotalRefunds;
    // Count of successful refund claims per trip; used to gate the solvency check (runs only before first claim)
    mapping(uint256 => uint256) public claimCount;

    uint256 public constant MAX_PARTICIPANTS = 50;
    uint256 public tripCount;
    IERC20 public immutable usdc;

    constructor(address usdcToken) {
        if (usdcToken == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcToken);
    }

    modifier tripExists(uint256 tripId) {
        if (!trips[tripId].exists) revert TripNotFound(tripId);
        _;
    }

    modifier onlyAdmin(uint256 tripId) {
        if (msg.sender != trips[tripId].admin) revert NotAdmin(tripId);
        _;
    }

    modifier onlyParticipant(uint256 tripId) {
        if (!isParticipant[tripId][msg.sender]) revert NotParticipant(tripId);
        _;
    }

    function createTrip(
        string calldata name,
        address[] calldata participants,
        uint256 targetBudget
    ) external returns (uint256 tripId) {
        uint256 providedParticipants = participants.length + 1;
        if (providedParticipants > MAX_PARTICIPANTS) {
            revert TooManyParticipants(MAX_PARTICIPANTS, providedParticipants);
        }

        tripCount += 1;
        tripId = tripCount;

        Trip storage trip = trips[tripId];
        trip.name = name;
        trip.admin = msg.sender;
        trip.targetBudget = targetBudget;
        trip.exists = true;

        isParticipant[tripId][msg.sender] = true;
        trip.participants.push(msg.sender);

        uint256 participantsLength = participants.length;
        for (uint256 i = 0; i < participantsLength; i++) {
            address participant = participants[i];
            if (participant == address(0)) revert ZeroAddress();
            if (isParticipant[tripId][participant]) revert AlreadyParticipant(participant);

            isParticipant[tripId][participant] = true;
            trip.participants.push(participant);
        }

        emit TripCreated(tripId, msg.sender, name, targetBudget);
    }

    function deposit(uint256 tripId, uint256 amount)
        external
        nonReentrant
        tripExists(tripId)
        onlyParticipant(tripId)
    {
        if (amount == 0) revert InvalidAmount();

        depositedAmount[tripId][msg.sender] += amount;
        tripBalance[tripId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(tripId, msg.sender, amount);
    }

    function releaseBudget(uint256 tripId, address spender, uint256 amount, string calldata memo)
        external
        nonReentrant
        tripExists(tripId)
        onlyAdmin(tripId)
    {
        if (spender == address(0)) revert ZeroAddress();
        if (!isParticipant[tripId][spender]) revert SpenderNotParticipant(spender);
        if (amount == 0) revert InvalidAmount();

        uint256 availableBalance = tripBalance[tripId];
        if (availableBalance < amount) revert InsufficientContractBalance(availableBalance, amount);

        allocatedBudget[tripId][spender] += amount;
        tripBalance[tripId] = availableBalance - amount;
        usdc.safeTransfer(spender, amount);

        emit BudgetReleased(tripId, spender, amount, memo);
    }

    function returnUnusedBudget(uint256 tripId, uint256 amount) external nonReentrant tripExists(tripId) {
        if (amount == 0) revert InvalidAmount();

        uint256 allocated = allocatedBudget[tripId][msg.sender];
        if (amount > allocated) revert ExceedsAllocated(allocated, amount);

        allocatedBudget[tripId][msg.sender] = allocated - amount;
        tripBalance[tripId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit BudgetReturned(tripId, msg.sender, amount);
    }

    function payDeficit(uint256 tripId, uint256 amount)
        external
        nonReentrant
        tripExists(tripId)
        onlyParticipant(tripId)
    {
        if (amount == 0) revert InvalidAmount();

        Trip storage trip = trips[tripId];
        if (!trip.settlementProposed) revert NoSettlementProposed();

        (uint256 index, bool found) = _findSettlementMemberIndex(trip, msg.sender);
        if (!found) revert NotParticipant(tripId);

        uint256 required = trip.requiredDeficits[index];
        uint256 paid = paidDeficit[tripId][msg.sender];

        if (paid + amount > required) {
            revert ExceedsRequiredDeficit(required, paid, amount);
        }

        paidDeficit[tripId][msg.sender] = paid + amount;
        tripBalance[tripId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit DeficitPaid(tripId, msg.sender, amount);
    }

    function proposeFinalSettlement(
        uint256 tripId,
        bytes32 ledgerHash,
        address[] calldata members,
        uint256[] calldata finalRefundAmounts,
        uint256[] calldata requiredDeficits
    ) external tripExists(tripId) onlyAdmin(tripId) {
        if (members.length != finalRefundAmounts.length || members.length != requiredDeficits.length) {
            revert ArrayLengthMismatch();
        }

        Trip storage trip = trips[tripId];
        if (members.length != trip.participants.length) {
            revert ArrayLengthMismatch();
        }

        uint256 membersLength = members.length;
        for (uint256 i = 0; i < membersLength; i++) {
            address member = members[i];
            if (member == address(0)) revert ZeroAddress();
            if (!isParticipant[tripId][member]) revert NotParticipant(tripId);
        }

        uint256 participantsLength = trip.participants.length;
        for (uint256 i = 0; i < participantsLength; i++) {
            address participant = trip.participants[i];
            uint256 occurrences = 0;

            for (uint256 j = 0; j < membersLength; j++) {
                if (members[j] == participant) {
                    occurrences += 1;
                }
            }

            if (occurrences != 1) revert InvalidSettlementMembers();
        }

        trip.pendingSettlementHash = ledgerHash;
        trip.settlementMembers = members;
        trip.finalRefundAmounts = finalRefundAmounts;
        trip.requiredDeficits = requiredDeficits;
        trip.settlementProposed = true;

        // Pre-compute and store total refunds for the solvency check in claimRefund
        uint256 totalRefunds = 0;
        for (uint256 i = 0; i < membersLength; i++) {
            totalRefunds += finalRefundAmounts[i];
        }
        settlementTotalRefunds[tripId] = totalRefunds;
        // Reset claim count so the solvency check triggers again on the next proposal
        claimCount[tripId] = 0;

        for (uint256 i = 0; i < membersLength; i++) {
            settlementApproved[tripId][trip.settlementMembers[i]] = false;
        }

        emit SettlementProposed(tripId, ledgerHash, members, finalRefundAmounts, requiredDeficits);
    }

    function approveFinalSettlement(uint256 tripId, bytes32 ledgerHash)
        external
        tripExists(tripId)
        onlyParticipant(tripId)
    {
        Trip storage trip = trips[tripId];
        if (!trip.settlementProposed) revert NoSettlementProposed();
        if (ledgerHash != trip.pendingSettlementHash) {
            revert SettlementHashMismatch(trip.pendingSettlementHash, ledgerHash);
        }

        settlementApproved[tripId][msg.sender] = true;

        emit SettlementApproved(tripId, msg.sender, ledgerHash);
    }

    function claimRefund(uint256 tripId)
        external
        nonReentrant
        tripExists(tripId)
        onlyParticipant(tripId)
    {
        Trip storage trip = trips[tripId];
        if (!trip.settlementProposed) revert NoSettlementProposed();
        if (refundClaimed[tripId][msg.sender]) revert AlreadyClaimed();

        address[] storage members = trip.settlementMembers;
        uint256[] storage refunds = trip.finalRefundAmounts;
        uint256[] storage deficits = trip.requiredDeficits;
        uint256 membersLength = members.length;

        // Validate unanimous approval and complete deficit payments for every member
        for (uint256 i = 0; i < membersLength; i++) {
            address member = members[i];
            if (!settlementApproved[tripId][member]) revert NotAllApproved();
            if (paidDeficit[tripId][member] != deficits[i]) revert DeficitNotFullyPaid();
        }

        // Solvency check: run exactly once (before the first successful claim).
        // After the first claim, tripBalance decreases as refunds are paid out, so a
        // repeated total-refund equality check would fail for all subsequent claimants.
        if (claimCount[tripId] == 0) {
            uint256 availableBalance = tripBalance[tripId];
            uint256 totalRefunds = settlementTotalRefunds[tripId];
            if (availableBalance != totalRefunds) {
                revert BalanceMismatch(availableBalance, totalRefunds);
            }
        }

        (uint256 index, bool found) = _findSettlementMemberIndex(trip, msg.sender);
        if (!found) revert NotParticipant(tripId);

        uint256 refundAmount = refunds[index];
        // CEI: state changes before external call
        refundClaimed[tripId][msg.sender] = true;
        claimCount[tripId] += 1;
        if (refundAmount > 0) {
            tripBalance[tripId] -= refundAmount;
        }

        if (refundAmount > 0) {
            usdc.safeTransfer(msg.sender, refundAmount);
        }

        emit RefundClaimed(tripId, msg.sender, refundAmount);
    }

    function getTrip(uint256 tripId) external view tripExists(tripId) returns (Trip memory) {
        return trips[tripId];
    }

    function getTripParticipants(uint256 tripId)
        external
        view
        tripExists(tripId)
        returns (address[] memory)
    {
        return trips[tripId].participants;
    }

    function getSettlementMembers(uint256 tripId)
        external
        view
        tripExists(tripId)
        returns (address[] memory)
    {
        return trips[tripId].settlementMembers;
    }

    function getSettlementDetails(uint256 tripId)
        external
        view
        tripExists(tripId)
        returns (
            bytes32 hash,
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits,
            bool proposed
        )
    {
        Trip storage trip = trips[tripId];
        return (
            trip.pendingSettlementHash,
            trip.settlementMembers,
            trip.finalRefundAmounts,
            trip.requiredDeficits,
            trip.settlementProposed
        );
    }

    function isAllApproved(uint256 tripId) external view tripExists(tripId) returns (bool) {
        Trip storage trip = trips[tripId];
        if (!trip.settlementProposed) return false;

        uint256 membersLength = trip.settlementMembers.length;
        for (uint256 i = 0; i < membersLength; i++) {
            if (!settlementApproved[tripId][trip.settlementMembers[i]]) {
                return false;
            }
        }

        return true;
    }

    function isAllDeficitPaid(uint256 tripId) external view tripExists(tripId) returns (bool) {
        Trip storage trip = trips[tripId];
        if (!trip.settlementProposed) return false;

        uint256 membersLength = trip.settlementMembers.length;
        for (uint256 i = 0; i < membersLength; i++) {
            address member = trip.settlementMembers[i];
            if (paidDeficit[tripId][member] != trip.requiredDeficits[i]) {
                return false;
            }
        }

        return true;
    }

    function getContractBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function getParticipantSettlementIndex(uint256 tripId, address participant)
        external
        view
        tripExists(tripId)
        returns (uint256 index, bool found)
    {
        Trip storage trip = trips[tripId];
        return _findSettlementMemberIndex(trip, participant);
    }

    function _findSettlementMemberIndex(Trip storage trip, address participant)
        internal
        view
        returns (uint256 index, bool found)
    {
        uint256 membersLength = trip.settlementMembers.length;
        for (uint256 i = 0; i < membersLength; i++) {
            if (trip.settlementMembers[i] == participant) {
                return (i, true);
            }
        }

        return (0, false);
    }
}
