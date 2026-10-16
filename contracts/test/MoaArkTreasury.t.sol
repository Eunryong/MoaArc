// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MoaArkTreasury} from "../MoaArkTreasury.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

contract MoaArkTreasuryTest is Test {
    // ─── actors ───────────────────────────────────────────────────────────────
    address internal admin   = makeAddr("admin");
    address internal alice   = makeAddr("alice");
    address internal bob     = makeAddr("bob");
    address internal carol   = makeAddr("carol");
    address internal outside = makeAddr("outside");   // never a participant

    // ─── contracts ────────────────────────────────────────────────────────────
    MockERC20          internal usdc;
    MoaArkTreasury     internal treasury;

    // ─── amounts (6-decimal USDC) ────────────────────────────────────────────
    uint256 internal constant DEPOSIT_AMOUNT  = 300e6;
    uint256 internal constant TARGET_BUDGET   = 900e6;
    uint256 internal constant BUDGET_RELEASE  = 100e6;
    uint256 internal constant MINT_AMOUNT     = 1_000e6;

    // ─── helpers ──────────────────────────────────────────────────────────────

    /// Deploy a fresh USDC mock + treasury and mint tokens to the three participants.
    function setUp() public {
        usdc     = new MockERC20("Mock USDC", "mUSDC", 6);
        treasury = new MoaArkTreasury(address(usdc));

        usdc.mint(admin, MINT_AMOUNT);
        usdc.mint(alice, MINT_AMOUNT);
        usdc.mint(bob,   MINT_AMOUNT);
        usdc.mint(carol, MINT_AMOUNT);
    }

    /// Creates a trip with admin + alice + bob.  Returns tripId (always 1 in fresh setUp).
    function _createDefaultTrip() internal returns (uint256 tripId) {
        address[] memory parts = new address[](2);
        parts[0] = alice;
        parts[1] = bob;
        vm.prank(admin);
        tripId = treasury.createTrip("Paris 2025", parts, TARGET_BUDGET);
    }

    /// All three participants deposit DEPOSIT_AMOUNT each into tripId.
    function _depositAll(uint256 tripId) internal {
        vm.startPrank(admin);
        usdc.approve(address(treasury), DEPOSIT_AMOUNT);
        treasury.deposit(tripId, DEPOSIT_AMOUNT);
        vm.stopPrank();

        vm.startPrank(alice);
        usdc.approve(address(treasury), DEPOSIT_AMOUNT);
        treasury.deposit(tripId, DEPOSIT_AMOUNT);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(treasury), DEPOSIT_AMOUNT);
        treasury.deposit(tripId, DEPOSIT_AMOUNT);
        vm.stopPrank();
    }

    /// Propose a "zero-deficit" settlement where admin gets all funds back and
    /// alice / bob get zero (or any distribution that matches the tripBalance).
    /// Returns (tripId, members, refunds, deficits, hash).
    function _proposeZeroDeficitSettlement(uint256 tripId)
        internal
        returns (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits,
            bytes32 h
        )
    {
        // tripBalance after 3x DEPOSIT_AMOUNT = 900e6; total refunds must match
        members  = new address[](3);
        refunds  = new uint256[](3);
        deficits = new uint256[](3);

        members[0] = admin;
        members[1] = alice;
        members[2] = bob;

        // distribute all 900e6 back to admin, 0 to others
        refunds[0] = DEPOSIT_AMOUNT * 3;  // 900e6 = full tripBalance
        refunds[1] = 0;
        refunds[2] = 0;

        // nobody owes a deficit
        deficits[0] = 0;
        deficits[1] = 0;
        deficits[2] = 0;

        uint256 version = treasury.getSettlementVersion(tripId) + 1;
        h = treasury.computeSettlementHash(tripId, version, members, refunds, deficits);

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
    }

    // =========================================================================
    //  1. VERSION constant
    // =========================================================================

    function test_VersionConstant() public view {
        assertEq(treasury.VERSION(), "MoaArk-1.0");
    }

    // =========================================================================
    //  2. createTrip
    // =========================================================================

    function test_CreateTrip_HappyPath() public {
        address[] memory parts = new address[](2);
        parts[0] = alice;
        parts[1] = bob;

        vm.prank(admin);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArkTreasury.TripCreated(1, admin, "Paris 2025", TARGET_BUDGET);
        uint256 tripId = treasury.createTrip("Paris 2025", parts, TARGET_BUDGET);

        assertEq(tripId, 1);
        assertEq(treasury.tripCount(), 1);

        MoaArkTreasury.Trip memory t = treasury.getTrip(tripId);
        assertEq(t.name, "Paris 2025");
        assertEq(t.admin, admin);
        assertEq(t.targetBudget, TARGET_BUDGET);
        assertTrue(t.exists);
        assertFalse(t.locked);

        // admin is auto-added as a participant
        assertTrue(treasury.isParticipant(tripId, admin));
        assertTrue(treasury.isParticipant(tripId, alice));
        assertTrue(treasury.isParticipant(tripId, bob));
        assertFalse(treasury.isParticipant(tripId, outside));
    }

    function test_CreateTrip_IncrementsTripCount() public {
        address[] memory parts = new address[](1);
        parts[0] = alice;

        vm.prank(admin);
        treasury.createTrip("Trip A", parts, 100e6);
        assertEq(treasury.tripCount(), 1);

        parts[0] = bob;
        vm.prank(alice);
        treasury.createTrip("Trip B", parts, 200e6);
        assertEq(treasury.tripCount(), 2);
    }

    function test_CreateTrip_RevertsZeroAddressParticipant() public {
        address[] memory parts = new address[](1);
        parts[0] = address(0);
        vm.prank(admin);
        vm.expectRevert(MoaArkTreasury.ZeroAddress.selector);
        treasury.createTrip("Bad", parts, 100e6);
    }

    function test_CreateTrip_RevertsDuplicateParticipant() public {
        address[] memory parts = new address[](2);
        parts[0] = alice;
        parts[1] = alice;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MoaArkTreasury.AlreadyParticipant.selector, alice));
        treasury.createTrip("Dup", parts, 100e6);
    }

    function test_CreateTrip_RevertsTooManyParticipants() public {
        // MAX_PARTICIPANTS = 50; we need to supply 50 extra (admin auto-added = 51)
        address[] memory parts = new address[](50);
        for (uint256 i = 0; i < 50; i++) {
            parts[i] = makeAddr(string(abi.encodePacked("p", i)));
        }
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(MoaArkTreasury.TooManyParticipants.selector, uint256(50), uint256(51))
        );
        treasury.createTrip("Big", parts, 100e6);
    }

    // =========================================================================
    //  3. deposit
    // =========================================================================

    function test_Deposit_HappyPath() public {
        uint256 tripId = _createDefaultTrip();

        vm.startPrank(alice);
        usdc.approve(address(treasury), DEPOSIT_AMOUNT);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArkTreasury.Deposited(tripId, alice, DEPOSIT_AMOUNT);
        treasury.deposit(tripId, DEPOSIT_AMOUNT);
        vm.stopPrank();

        assertEq(treasury.depositedAmount(tripId, alice), DEPOSIT_AMOUNT);
        assertEq(treasury.tripBalance(tripId), DEPOSIT_AMOUNT);
        assertEq(usdc.balanceOf(address(treasury)), DEPOSIT_AMOUNT);
    }

    function test_Deposit_UpdatesBalanceForMultipleDepositors() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        assertEq(treasury.tripBalance(tripId), DEPOSIT_AMOUNT * 3);
        assertEq(treasury.depositedAmount(tripId, admin), DEPOSIT_AMOUNT);
        assertEq(treasury.depositedAmount(tripId, alice), DEPOSIT_AMOUNT);
        assertEq(treasury.depositedAmount(tripId, bob),   DEPOSIT_AMOUNT);
    }

    function test_Deposit_RevertsForNonParticipant() public {
        uint256 tripId = _createDefaultTrip();
        usdc.mint(outside, DEPOSIT_AMOUNT);
        vm.startPrank(outside);
        usdc.approve(address(treasury), DEPOSIT_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(MoaArkTreasury.NotParticipant.selector, tripId));
        treasury.deposit(tripId, DEPOSIT_AMOUNT);
        vm.stopPrank();
    }

    function test_Deposit_RevertsZeroAmount() public {
        uint256 tripId = _createDefaultTrip();
        vm.prank(alice);
        vm.expectRevert(MoaArkTreasury.InvalidAmount.selector);
        treasury.deposit(tripId, 0);
    }

    function test_Deposit_RevertsForUnknownTrip() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MoaArkTreasury.TripNotFound.selector, uint256(99)));
        treasury.deposit(99, DEPOSIT_AMOUNT);
    }

    // =========================================================================
    //  4. releaseBudget — spender must be participant
    // =========================================================================

    function test_ReleaseBudget_HappyPath() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        vm.prank(admin);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArkTreasury.BudgetReleased(tripId, alice, BUDGET_RELEASE, "hotel");
        treasury.releaseBudget(tripId, alice, BUDGET_RELEASE, "hotel");

        assertEq(treasury.allocatedBudget(tripId, alice), BUDGET_RELEASE);
        assertEq(treasury.tripBalance(tripId), DEPOSIT_AMOUNT * 3 - BUDGET_RELEASE);
        assertEq(usdc.balanceOf(alice), MINT_AMOUNT - DEPOSIT_AMOUNT + BUDGET_RELEASE);
    }

    function test_ReleaseBudget_RevertsNonAdmin() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MoaArkTreasury.NotAdmin.selector, tripId));
        treasury.releaseBudget(tripId, alice, BUDGET_RELEASE, "hotel");
    }

    function test_ReleaseBudget_RevertsSpenderNotParticipant() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MoaArkTreasury.SpenderNotParticipant.selector, outside));
        treasury.releaseBudget(tripId, outside, BUDGET_RELEASE, "hotel");
    }

    function test_ReleaseBudget_RevertsInsufficientBalance() public {
        uint256 tripId = _createDefaultTrip();
        // No deposits — balance is zero
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArkTreasury.InsufficientContractBalance.selector,
                uint256(0),
                BUDGET_RELEASE
            )
        );
        treasury.releaseBudget(tripId, alice, BUDGET_RELEASE, "hotel");
    }

    function test_ReleaseBudget_RevertsZeroAmount() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);
        vm.prank(admin);
        vm.expectRevert(MoaArkTreasury.InvalidAmount.selector);
        treasury.releaseBudget(tripId, alice, 0, "hotel");
    }

    // =========================================================================
    //  5. returnUnusedBudget
    // =========================================================================

    function test_ReturnUnusedBudget_HappyPath() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        // admin releases 100e6 to alice
        vm.prank(admin);
        treasury.releaseBudget(tripId, alice, BUDGET_RELEASE, "hotel");

        uint256 balanceBefore = treasury.tripBalance(tripId);

        // alice returns 50e6 back
        uint256 returnAmount = 50e6;
        vm.startPrank(alice);
        usdc.approve(address(treasury), returnAmount);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArkTreasury.BudgetReturned(tripId, alice, returnAmount);
        treasury.returnUnusedBudget(tripId, returnAmount);
        vm.stopPrank();

        assertEq(treasury.allocatedBudget(tripId, alice), BUDGET_RELEASE - returnAmount);
        assertEq(treasury.tripBalance(tripId), balanceBefore + returnAmount);
    }

    function test_ReturnUnusedBudget_RevertsExceedsAllocated() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        // alice has zero allocated
        vm.startPrank(alice);
        usdc.approve(address(treasury), 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(MoaArkTreasury.ExceedsAllocated.selector, uint256(0), uint256(1e6))
        );
        treasury.returnUnusedBudget(tripId, 1e6);
        vm.stopPrank();
    }

    function test_ReturnUnusedBudget_RevertsZeroAmount() public {
        uint256 tripId = _createDefaultTrip();
        vm.prank(alice);
        vm.expectRevert(MoaArkTreasury.InvalidAmount.selector);
        treasury.returnUnusedBudget(tripId, 0);
    }

    // =========================================================================
    //  6. proposeFinalSettlement
    // =========================================================================

    function test_ProposeFinalSettlement_HappyPath() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        address[] memory members  = new address[](3);
        uint256[] memory refunds  = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = DEPOSIT_AMOUNT * 3; refunds[1] = 0; refunds[2] = 0;

        uint256 expectedVersion = treasury.getSettlementVersion(tripId) + 1;
        bytes32 expectedHash = treasury.computeSettlementHash(
            tripId, expectedVersion, members, refunds, deficits
        );

        vm.prank(admin);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArkTreasury.SettlementProposed(tripId, expectedHash, members, refunds, deficits);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);

        assertEq(uint256(treasury.getSettlementStatus(tripId)), uint256(MoaArkTreasury.SettlementStatus.Proposed));
        assertEq(treasury.getSettlementVersion(tripId), 1);

        (, , , , bool proposed) = treasury.getSettlementDetails(tripId);
        assertTrue(proposed);
    }

    function test_ProposeFinalSettlement_BlockedAfterDeficitPayingStatus() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        // 1. Propose a settlement where bob owes a deficit
        address[] memory members  = new address[](3);
        uint256[] memory refunds  = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0]  = admin; members[1] = alice; members[2] = bob;
        refunds[0]  = DEPOSIT_AMOUNT * 3;
        deficits[2] = 50e6; // bob owes 50e6

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);

        // 2. Bob pays part of the deficit → status moves to DeficitPaying
        usdc.mint(bob, 50e6);
        vm.startPrank(bob);
        usdc.approve(address(treasury), 50e6);
        treasury.payDeficit(tripId, 50e6);
        vm.stopPrank();

        assertEq(
            uint256(treasury.getSettlementStatus(tripId)),
            uint256(MoaArkTreasury.SettlementStatus.DeficitPaying)
        );

        // 3. Re-proposing now must revert with SettlementAlreadyInProgress
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArkTreasury.SettlementAlreadyInProgress.selector,
                MoaArkTreasury.SettlementStatus.DeficitPaying
            )
        );
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
    }

    function test_ProposeFinalSettlement_RevertsNonAdmin() public {
        uint256 tripId = _createDefaultTrip();
        address[] memory members  = new address[](3);
        uint256[] memory refunds  = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MoaArkTreasury.NotAdmin.selector, tripId));
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
    }

    function test_ProposeFinalSettlement_RevertsArrayLengthMismatch() public {
        uint256 tripId = _createDefaultTrip();
        address[] memory members  = new address[](3);
        uint256[] memory refunds  = new uint256[](2); // wrong length
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        vm.prank(admin);
        vm.expectRevert(MoaArkTreasury.ArrayLengthMismatch.selector);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
    }

    function test_ProposeFinalSettlement_CanReproposeWhileProposed() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        address[] memory members  = new address[](3);
        uint256[] memory refunds  = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = DEPOSIT_AMOUNT * 3;

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        // version = 1

        // Re-propose while still Proposed status — should succeed, version bumps
        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        assertEq(treasury.getSettlementVersion(tripId), 2);
    }

    // =========================================================================
    //  7. payDeficit
    // =========================================================================

    function test_PayDeficit_HappyPath() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        address[] memory members  = new address[](3);
        uint256[] memory refunds  = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0]  = admin; members[1] = alice; members[2] = bob;
        // tripBalance = 900e6; give 1000e6 in refunds → bob must pay 100e6 deficit
        refunds[0]  = 500e6;
        refunds[1]  = 500e6;
        deficits[2] = 100e6;

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);

        usdc.mint(bob, 100e6);
        vm.startPrank(bob);
        usdc.approve(address(treasury), 100e6);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArkTreasury.DeficitPaid(tripId, bob, 100e6);
        treasury.payDeficit(tripId, 100e6);
        vm.stopPrank();

        assertEq(treasury.paidDeficit(tripId, bob), 100e6);
        assertEq(
            uint256(treasury.getSettlementStatus(tripId)),
            uint256(MoaArkTreasury.SettlementStatus.DeficitPaying)
        );
    }

    function test_PayDeficit_RevertsNoSettlementProposed() public {
        uint256 tripId = _createDefaultTrip();
        vm.prank(alice);
        vm.expectRevert(MoaArkTreasury.NoSettlementProposed.selector);
        treasury.payDeficit(tripId, 50e6);
    }

    function test_PayDeficit_RevertsExceedsRequired() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        address[] memory members  = new address[](3);
        uint256[] memory refunds  = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0]  = admin; members[1] = alice; members[2] = bob;
        refunds[0]  = DEPOSIT_AMOUNT * 3;
        deficits[2] = 50e6;

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);

        usdc.mint(bob, 100e6);
        vm.startPrank(bob);
        usdc.approve(address(treasury), 100e6);
        // Try to pay 60e6 where required is 50e6
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArkTreasury.ExceedsRequiredDeficit.selector,
                uint256(50e6),
                uint256(0),
                uint256(60e6)
            )
        );
        treasury.payDeficit(tripId, 60e6);
        vm.stopPrank();
    }

    // =========================================================================
    //  8. approveFinalSettlement — hash must match computeSettlementHash
    // =========================================================================

    function test_ApproveFinalSettlement_HappyPath() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits,
            bytes32 h
        ) = _proposeZeroDeficitSettlement(tripId);

        vm.prank(admin);
        vm.expectEmit(true, true, true, true, address(treasury));
        emit MoaArkTreasury.SettlementApproved(tripId, admin, h);
        treasury.approveFinalSettlement(tripId, h);

        assertTrue(treasury.settlementApproved(tripId, admin));

        vm.prank(alice);
        treasury.approveFinalSettlement(tripId, h);
        assertTrue(treasury.settlementApproved(tripId, alice));

        vm.prank(bob);
        treasury.approveFinalSettlement(tripId, h);
        assertTrue(treasury.settlementApproved(tripId, bob));

        assertTrue(treasury.isAllApproved(tripId));
        
        // suppress unused variable warnings
        (members, refunds, deficits) = (members, refunds, deficits);
    }

    function test_ApproveFinalSettlement_RevertsHashMismatch() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        (, , , bytes32 correctHash) = _proposeZeroDeficitSettlement(tripId);

        bytes32 wrongHash = keccak256("wrong");
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArkTreasury.InvalidSettlementHash.selector,
                correctHash,
                wrongHash
            )
        );
        treasury.approveFinalSettlement(tripId, wrongHash);
    }

    function test_ApproveFinalSettlement_RevertsNoSettlementProposed() public {
        uint256 tripId = _createDefaultTrip();
        vm.prank(alice);
        vm.expectRevert(MoaArkTreasury.NoSettlementProposed.selector);
        treasury.approveFinalSettlement(tripId, bytes32(0));
    }

    function test_ApproveFinalSettlement_RevertsNonParticipant() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);
        (, , , bytes32 h) = _proposeZeroDeficitSettlement(tripId);

        vm.prank(outside);
        vm.expectRevert(abi.encodeWithSelector(MoaArkTreasury.NotParticipant.selector, tripId));
        treasury.approveFinalSettlement(tripId, h);
    }

    // =========================================================================
    //  9. claimRefund — all approve + exact balance check
    // =========================================================================

    function _fullSettlementFlow(uint256 tripId) internal returns (bytes32 h) {
        address[] memory members;
        uint256[] memory refunds;
        uint256[] memory deficits;
        (members, refunds, deficits, h) = _proposeZeroDeficitSettlement(tripId);

        vm.prank(admin);
        treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice);
        treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);
        treasury.approveFinalSettlement(tripId, h);
        
        // suppress unused variable warnings
        (members, refunds, deficits) = (members, refunds, deficits);
    }

    function test_ClaimRefund_HappyPath_AdminGetsAll() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);          // 900e6 in contract
        _fullSettlementFlow(tripId);  // all approve, admin refund = 900e6

        uint256 adminBefore = usdc.balanceOf(admin);

        vm.prank(admin);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArkTreasury.RefundClaimed(tripId, admin, DEPOSIT_AMOUNT * 3);
        treasury.claimRefund(tripId);

        assertEq(usdc.balanceOf(admin), adminBefore + DEPOSIT_AMOUNT * 3);
        assertTrue(treasury.refundClaimed(tripId, admin));
    }

    function test_ClaimRefund_ZeroRefundParticipant() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);
        _fullSettlementFlow(tripId); // alice refund = 0

        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArkTreasury.RefundClaimed(tripId, alice, 0);
        treasury.claimRefund(tripId);

        // Alice gets 0 back — balance unchanged
        assertEq(usdc.balanceOf(alice), aliceBefore);
        assertTrue(treasury.refundClaimed(tripId, alice));
    }

    function test_ClaimRefund_AllParticipantsClaim_TripCompleted() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);
        _fullSettlementFlow(tripId);

        vm.prank(admin);
        treasury.claimRefund(tripId);
        vm.prank(alice);
        treasury.claimRefund(tripId);

        vm.prank(bob);
        vm.expectEmit(true, false, false, false, address(treasury));
        emit MoaArkTreasury.TripCompleted(tripId);
        treasury.claimRefund(tripId);

        assertEq(
            uint256(treasury.getSettlementStatus(tripId)),
            uint256(MoaArkTreasury.SettlementStatus.Completed)
        );
        assertEq(treasury.tripBalance(tripId), 0);
    }

    function test_ClaimRefund_RevertsAlreadyClaimed() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);
        _fullSettlementFlow(tripId);

        vm.prank(admin);
        treasury.claimRefund(tripId);

        vm.prank(admin);
        vm.expectRevert(MoaArkTreasury.AlreadyClaimed.selector);
        treasury.claimRefund(tripId);
    }

    function test_ClaimRefund_RevertsNotAllApproved() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        (, , , bytes32 h) = _proposeZeroDeficitSettlement(tripId);

        // Only admin approves — alice and bob have not
        vm.prank(admin);
        treasury.approveFinalSettlement(tripId, h);

        vm.prank(admin);
        vm.expectRevert(MoaArkTreasury.NotAllApproved.selector);
        treasury.claimRefund(tripId);
    }

    function test_ClaimRefund_RevertsBalanceMismatch() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId); // 900e6

        // Propose settlement with total refunds = 500e6 (≠ 900e6 in contract)
        address[] memory members  = new address[](3);
        uint256[] memory refunds  = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = 300e6;
        refunds[1] = 100e6;
        refunds[2] = 100e6; // total = 500e6

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);

        bytes32 h = treasury.computeSettlementHash(
            tripId, 1, members, refunds, deficits
        );

        vm.prank(admin);
        treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice);
        treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);
        treasury.approveFinalSettlement(tripId, h);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArkTreasury.BalanceMismatch.selector,
                uint256(900e6),
                uint256(500e6)
            )
        );
        treasury.claimRefund(tripId);
    }

    function test_ClaimRefund_RevertsNoSettlementProposed() public {
        uint256 tripId = _createDefaultTrip();
        vm.prank(admin);
        vm.expectRevert(MoaArkTreasury.NoSettlementProposed.selector);
        treasury.claimRefund(tripId);
    }

    // =========================================================================
    //  10. Per-trip balance isolation (two trips)
    // =========================================================================

    function test_TripBalanceIsolation_TwoTrips() public {
        // ── Trip 1: admin + alice ──────────────────────────────────────────────
        address[] memory parts1 = new address[](1);
        parts1[0] = alice;
        vm.prank(admin);
        uint256 trip1 = treasury.createTrip("Trip One", parts1, 200e6);

        // ── Trip 2: admin + bob ───────────────────────────────────────────────
        address[] memory parts2 = new address[](1);
        parts2[0] = bob;
        vm.prank(admin);
        uint256 trip2 = treasury.createTrip("Trip Two", parts2, 200e6);

        uint256 deposit1 = 150e6;
        uint256 deposit2 = 75e6;

        // Deposit into trip 1
        vm.startPrank(admin);
        usdc.approve(address(treasury), deposit1);
        treasury.deposit(trip1, deposit1);
        vm.stopPrank();

        // Deposit into trip 2
        vm.startPrank(admin);
        usdc.approve(address(treasury), deposit2);
        treasury.deposit(trip2, deposit2);
        vm.stopPrank();

        // Each trip's balance is independent
        assertEq(treasury.tripBalance(trip1), deposit1);
        assertEq(treasury.tripBalance(trip2), deposit2);

        // Total contract balance = sum of both
        assertEq(usdc.balanceOf(address(treasury)), deposit1 + deposit2);

        // Deposited amounts are per-trip, not cross-contaminated
        assertEq(treasury.depositedAmount(trip1, admin), deposit1);
        assertEq(treasury.depositedAmount(trip2, admin), deposit2);
        assertEq(treasury.depositedAmount(trip1, bob),   0);   // bob not in trip1
        assertEq(treasury.depositedAmount(trip2, alice), 0);   // alice not in trip2

        // Budget release from trip1 does NOT affect trip2 balance
        vm.startPrank(alice);
        usdc.approve(address(treasury), deposit1);
        treasury.deposit(trip1, deposit1);
        vm.stopPrank();

        vm.prank(admin);
        treasury.releaseBudget(trip1, alice, 50e6, "lunch");

        assertEq(treasury.tripBalance(trip1), deposit1 * 2 - 50e6);
        assertEq(treasury.tripBalance(trip2), deposit2); // unchanged
    }

    // =========================================================================
    //  11. computeSettlementHash
    // =========================================================================

    function test_ComputeSettlementHash_MatchesOnChain() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);

        address[] memory members  = new address[](3);
        uint256[] memory refunds  = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = DEPOSIT_AMOUNT * 3;

        uint256 expectedVersion = 1;
        bytes32 onChainHash = treasury.computeSettlementHash(
            tripId, expectedVersion, members, refunds, deficits
        );
        bytes32 localHash = keccak256(abi.encode(tripId, expectedVersion, members, refunds, deficits));

        assertEq(onChainHash, localHash);
    }

    // =========================================================================
    //  12. Fuzz: deposit amount in arbitrary valid range
    // =========================================================================

    function testFuzz_Deposit_BalanceTracked(uint96 amount) public {
        uint256 amt = bound(uint256(amount), 1, MINT_AMOUNT);
        uint256 tripId = _createDefaultTrip();

        vm.startPrank(alice);
        usdc.approve(address(treasury), amt);
        treasury.deposit(tripId, amt);
        vm.stopPrank();

        assertEq(treasury.depositedAmount(tripId, alice), amt);
        assertEq(treasury.tripBalance(tripId), amt);
    }

    // =========================================================================
    //  13. Invariant-style: tripBalance == sum of deposits - released budgets
    // =========================================================================

    function test_Invariant_TripBalance_EqualsSumDepositedMinusReleased() public {
        uint256 tripId = _createDefaultTrip();
        _depositAll(tripId);  // 3 × 300e6 = 900e6

        uint256 released = 120e6;
        vm.prank(admin);
        treasury.releaseBudget(tripId, alice, released, "spend");

        uint256 expectedBalance = DEPOSIT_AMOUNT * 3 - released;
        assertEq(treasury.tripBalance(tripId), expectedBalance);
        // The USDC actually sitting in the contract also matches
        // (alice received 120e6, so contract holds 900e6 - 120e6)
        assertEq(usdc.balanceOf(address(treasury)), expectedBalance);
    }
}
