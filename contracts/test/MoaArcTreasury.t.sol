// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MoaArcTreasury} from "../MoaArcTreasury.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Handler for invariant testing
// Uses tripBalance snapshots (before/after) so the tracked delta is always exact.
// ─────────────────────────────────────────────────────────────────────────────
contract TreasuryHandler is Test {
    MoaArcTreasury internal treasury;
    MockERC20 internal usdc;

    address internal admin = makeAddr("h_admin");
    address internal alice = makeAddr("h_alice");
    address internal bob   = makeAddr("h_bob");

    uint256 public tripId;
    // ghost variable: mirrors what tripBalance(tripId) should be
    uint256 public ghostBalance;

    constructor(MoaArcTreasury _treasury, MockERC20 _usdc) {
        treasury = _treasury;
        usdc     = _usdc;

        // Generous mint so the handler never runs out of tokens
        usdc.mint(admin, 1_000_000e6);
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob,   1_000_000e6);

        address[] memory parts = new address[](2);
        parts[0] = alice;
        parts[1] = bob;
        vm.prank(admin);
        tripId = treasury.createTrip("Inv Trip", parts, 900_000e6);
        ghostBalance = 0;
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 1_000e6);
        // Only deposit when trip is still open (None or Proposed status is fine for deposits)
        MoaArcTreasury.SettlementStatus status = treasury.getSettlementStatus(tripId);
        if (status == MoaArcTreasury.SettlementStatus.DeficitPaying  ||
            status == MoaArcTreasury.SettlementStatus.ClaimStarted   ||
            status == MoaArcTreasury.SettlementStatus.Completed) return;

        vm.startPrank(alice);
        usdc.approve(address(treasury), amount);
        treasury.deposit(tripId, amount);
        vm.stopPrank();
        ghostBalance += amount;
    }

    function releaseBudget(uint256 amount) external {
        MoaArcTreasury.SettlementStatus status = treasury.getSettlementStatus(tripId);
        if (status != MoaArcTreasury.SettlementStatus.None) return;
        uint256 bal = treasury.tripBalance(tripId);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);

        vm.prank(admin);
        treasury.releaseBudget(tripId, alice, amount, "inv spend");
        ghostBalance -= amount;
    }

    function returnBudget(uint256 amount) external {
        uint256 allocated = treasury.allocatedBudget(tripId, alice);
        if (allocated == 0) return;
        MoaArcTreasury.SettlementStatus status = treasury.getSettlementStatus(tripId);
        if (status != MoaArcTreasury.SettlementStatus.None) return;
        amount = bound(amount, 1, allocated);

        vm.startPrank(alice);
        usdc.approve(address(treasury), amount);
        treasury.returnUnusedBudget(tripId, amount);
        vm.stopPrank();
        ghostBalance += amount;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main test contract
// ─────────────────────────────────────────────────────────────────────────────
contract MoaArcTreasuryTest is Test {
    // ── actors ────────────────────────────────────────────────────────────────
    address internal admin   = makeAddr("admin");
    address internal alice   = makeAddr("alice");
    address internal bob     = makeAddr("bob");
    address internal carol   = makeAddr("carol");
    address internal outside = makeAddr("outside");

    // ── contracts ─────────────────────────────────────────────────────────────
    MockERC20        internal usdc;
    MoaArcTreasury   internal treasury;

    // ── amounts (6-decimal USDC) ──────────────────────────────────────────────
    uint256 internal constant DEPOSIT_AMOUNT = 300e6;
    uint256 internal constant TARGET_BUDGET  = 900e6;
    uint256 internal constant MINT_AMOUNT    = 2_000e6;

    // ─────────────────────────────────────────────────────────────────────────
    // setUp  — runs before every test
    // ─────────────────────────────────────────────────────────────────────────
    function setUp() public {
        usdc     = new MockERC20("Mock USDC", "mUSDC", 6);
        treasury = new MoaArcTreasury(address(usdc));

        usdc.mint(admin, MINT_AMOUNT);
        usdc.mint(alice, MINT_AMOUNT);
        usdc.mint(bob,   MINT_AMOUNT);
        usdc.mint(carol, MINT_AMOUNT);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// Creates trip: admin + alice + bob.  Returns tripId (= 1 on fresh state).
    function _createDefaultTrip() internal returns (uint256 tripId) {
        address[] memory parts = new address[](2);
        parts[0] = alice;
        parts[1] = bob;
        vm.prank(admin);
        tripId = treasury.createTrip("Paris 2025", parts, TARGET_BUDGET);
    }

    /// All three participants deposit DEPOSIT_AMOUNT.
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

    /// Propose a zero-deficit settlement: admin gets 900e6, alice/bob get 0, nobody owes deficit.
    /// Total refunds = 900e6 = tripBalance after _depositAll.
    function _proposeZeroDeficitSettlement(uint256 tripId)
        internal
        returns (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits,
            bytes32 h
        )
    {
        members = new address[](3);
        refunds = new uint256[](3);
        deficits = new uint256[](3);

        members[0] = admin;
        members[1] = alice;
        members[2] = bob;

        refunds[0] = 900e6; // admin gets everything back (trip balance)
        refunds[1] = 0;
        refunds[2] = 0;
        // no deficits required

        uint256 version = treasury.getSettlementVersion(tripId) + 1;
        h = keccak256(abi.encode(tripId, version, members, refunds, deficits));

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
    }

    /// Approve the settlement from all three participants.
    function _approveAll(uint256 tripId, bytes32 h) internal {
        vm.prank(admin);
        treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice);
        treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);
        treasury.approveFinalSettlement(tripId, h);
    }

    // =========================================================================
    // 1. VERSION constant
    // =========================================================================

    function test_VersionConstant() public view {
        assertEq(treasury.VERSION(), "MoaArc-2.0");
    }

    // =========================================================================
    // 2. releaseBudget blocked when settlementStatus != None
    // =========================================================================

    function test_ReleaseBudget_RevertsWhenProposed() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);
        _proposeZeroDeficitSettlement(id);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.SettlementProposedLock.selector,
                MoaArcTreasury.SettlementStatus.Proposed
            )
        );
        treasury.releaseBudget(id, alice, 1e6, "blocked");
    }

    function test_ReleaseBudget_RevertsWhenDeficitPaying() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        // Set up a settlement where alice owes a deficit
        address[] memory members = new address[](3);
        uint256[] memory refunds = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = 950e6; refunds[1] = 0; refunds[2] = 0;
        deficits[0] = 0; deficits[1] = 50e6; deficits[2] = 0;

        vm.prank(admin);
        treasury.proposeFinalSettlement(id, members, refunds, deficits);

        bytes32 h = treasury.computeSettlementHash(id, 1, members, refunds, deficits);

        // alice pays deficit → transitions to DeficitPaying
        vm.startPrank(alice);
        usdc.approve(address(treasury), 50e6);
        treasury.payDeficit(id, 50e6);
        vm.stopPrank();

        assertEq(
            uint256(treasury.getSettlementStatus(id)),
            uint256(MoaArcTreasury.SettlementStatus.DeficitPaying)
        );

        // releaseBudget must now revert
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.SettlementProposedLock.selector,
                MoaArcTreasury.SettlementStatus.DeficitPaying
            )
        );
        treasury.releaseBudget(id, alice, 1e6, "blocked");
    }

    function test_ReleaseBudget_RevertsWhenClaimStarted() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);
        (, , , bytes32 h) = _proposeZeroDeficitSettlement(id);
        _approveAll(id, h);

        // admin claims — transitions to ClaimStarted
        vm.prank(admin);
        treasury.claimRefund(id);

        assertEq(
            uint256(treasury.getSettlementStatus(id)),
            uint256(MoaArcTreasury.SettlementStatus.ClaimStarted)
        );

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.SettlementProposedLock.selector,
                MoaArcTreasury.SettlementStatus.ClaimStarted
            )
        );
        treasury.releaseBudget(id, alice, 1e6, "blocked");
    }

    // =========================================================================
    // 3. returnUnusedBudget blocked when settlementStatus != None
    // =========================================================================

    function test_ReturnUnusedBudget_RevertsWhenProposed() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        // Give alice some allocated budget first
        vm.prank(admin);
        treasury.releaseBudget(id, alice, 100e6, "spend money");

        // Now propose settlement
        address[] memory members = new address[](3);
        uint256[] memory refunds = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = 800e6; refunds[1] = 0; refunds[2] = 0;
        deficits[0] = 0; deficits[1] = 0; deficits[2] = 0;
        vm.prank(admin);
        treasury.proposeFinalSettlement(id, members, refunds, deficits);

        // returnUnusedBudget must be blocked
        vm.startPrank(alice);
        usdc.approve(address(treasury), 100e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.SettlementProposedLock.selector,
                MoaArcTreasury.SettlementStatus.Proposed
            )
        );
        treasury.returnUnusedBudget(id, 100e6);
        vm.stopPrank();
    }

    function test_ReturnUnusedBudget_RevertsWhenDeficitPaying() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        // Give alice budget
        vm.prank(admin);
        treasury.releaseBudget(id, alice, 50e6, "spend");

        // Propose with alice owing a deficit
        address[] memory members = new address[](3);
        uint256[] memory refunds = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = 900e6; refunds[1] = 0; refunds[2] = 0;
        deficits[0] = 0; deficits[1] = 50e6; deficits[2] = 0;
        vm.prank(admin);
        treasury.proposeFinalSettlement(id, members, refunds, deficits);

        // alice pays deficit → DeficitPaying
        vm.startPrank(alice);
        usdc.approve(address(treasury), 50e6);
        treasury.payDeficit(id, 50e6);
        vm.stopPrank();

        // returnUnusedBudget should be blocked
        vm.startPrank(alice);
        usdc.approve(address(treasury), 50e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.SettlementProposedLock.selector,
                MoaArcTreasury.SettlementStatus.DeficitPaying
            )
        );
        treasury.returnUnusedBudget(id, 50e6);
        vm.stopPrank();
    }

    // =========================================================================
    // 4. releaseBudget allowed when settlementStatus == None
    // =========================================================================

    function test_ReleaseBudget_HappyPath() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        uint256 aliceBalBefore = usdc.balanceOf(alice);
        uint256 tripBalBefore  = treasury.tripBalance(id);

        vm.prank(admin);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArcTreasury.BudgetReleased(id, alice, 100e6, "hotel");
        treasury.releaseBudget(id, alice, 100e6, "hotel");

        assertEq(usdc.balanceOf(alice),         aliceBalBefore + 100e6);
        assertEq(treasury.tripBalance(id),      tripBalBefore  - 100e6);
        assertEq(treasury.allocatedBudget(id, alice), 100e6);
    }

    function test_ReleaseBudget_RevertsNonAdmin() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MoaArcTreasury.NotAdmin.selector, id));
        treasury.releaseBudget(id, alice, 10e6, "nope");
    }

    function test_ReleaseBudget_RevertsInsufficientBalance() public {
        uint256 id = _createDefaultTrip();
        // deposit only 100e6 total
        vm.startPrank(admin);
        usdc.approve(address(treasury), 100e6);
        treasury.deposit(id, 100e6);
        vm.stopPrank();

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.InsufficientContractBalance.selector,
                100e6,
                200e6
            )
        );
        treasury.releaseBudget(id, alice, 200e6, "too much");
    }

    function test_ReleaseBudget_RevertsZeroAmount() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        vm.prank(admin);
        vm.expectRevert(MoaArcTreasury.InvalidAmount.selector);
        treasury.releaseBudget(id, alice, 0, "zero");
    }

    function test_ReleaseBudget_RevertsZeroSpender() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        vm.prank(admin);
        vm.expectRevert(MoaArcTreasury.ZeroAddress.selector);
        treasury.releaseBudget(id, address(0), 10e6, "zero addr");
    }

    function test_ReleaseBudget_RevertsSpenderNotParticipant() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(MoaArcTreasury.SpenderNotParticipant.selector, outside)
        );
        treasury.releaseBudget(id, outside, 10e6, "not a participant");
    }

    // =========================================================================
    // 5. cancelSettlement: happy path
    // =========================================================================

    function test_CancelSettlement_HappyPath() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);
        (, , , bytes32 h) = _proposeZeroDeficitSettlement(id);

        // alice approves before cancellation so we can verify approval is cleared
        vm.prank(alice);
        treasury.approveFinalSettlement(id, h);
        assertTrue(treasury.settlementApproved(id, alice));

        // admin cancels
        vm.prank(admin);
        vm.expectEmit(true, false, false, false, address(treasury));
        emit MoaArcTreasury.SettlementCancelled(id);
        treasury.cancelSettlement(id);

        // status resets to None
        assertEq(
            uint256(treasury.getSettlementStatus(id)),
            uint256(MoaArcTreasury.SettlementStatus.None)
        );

        // approvals cleared for all settlement members
        assertFalse(treasury.settlementApproved(id, admin));
        assertFalse(treasury.settlementApproved(id, alice));
        assertFalse(treasury.settlementApproved(id, bob));
    }

    function test_CancelSettlement_RevertsNonAdmin() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);
        _proposeZeroDeficitSettlement(id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MoaArcTreasury.NotAdmin.selector, id));
        treasury.cancelSettlement(id);
    }

    // =========================================================================
    // 6. cancelSettlement reverts when status is None
    // =========================================================================

    function test_CancelSettlement_RevertsWhenNone() public {
        uint256 id = _createDefaultTrip();

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.SettlementAlreadyFinalizing.selector,
                MoaArcTreasury.SettlementStatus.None
            )
        );
        treasury.cancelSettlement(id);
    }

    // =========================================================================
    // 7. cancelSettlement reverts when status is DeficitPaying or higher
    // =========================================================================

    function test_CancelSettlement_RevertsWhenDeficitPaying() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        // Propose with alice owing a deficit
        address[] memory members = new address[](3);
        uint256[] memory refunds = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = 950e6; refunds[1] = 0; refunds[2] = 0;
        deficits[0] = 0; deficits[1] = 50e6; deficits[2] = 0;
        vm.prank(admin);
        treasury.proposeFinalSettlement(id, members, refunds, deficits);

        // Push to DeficitPaying by having alice pay part of the deficit
        vm.startPrank(alice);
        usdc.approve(address(treasury), 50e6);
        treasury.payDeficit(id, 50e6);
        vm.stopPrank();

        assertEq(
            uint256(treasury.getSettlementStatus(id)),
            uint256(MoaArcTreasury.SettlementStatus.DeficitPaying)
        );

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.SettlementAlreadyFinalizing.selector,
                MoaArcTreasury.SettlementStatus.DeficitPaying
            )
        );
        treasury.cancelSettlement(id);
    }

    function test_CancelSettlement_RevertsWhenClaimStarted() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);
        (, , , bytes32 h) = _proposeZeroDeficitSettlement(id);
        _approveAll(id, h);

        // Trigger ClaimStarted by having admin claim
        vm.prank(admin);
        treasury.claimRefund(id);

        assertEq(
            uint256(treasury.getSettlementStatus(id)),
            uint256(MoaArcTreasury.SettlementStatus.ClaimStarted)
        );

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.SettlementAlreadyFinalizing.selector,
                MoaArcTreasury.SettlementStatus.ClaimStarted
            )
        );
        treasury.cancelSettlement(id);
    }

    // =========================================================================
    // 8. After cancelSettlement: releaseBudget works again
    // =========================================================================

    function test_ReleaseBudget_WorksAfterCancelSettlement() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);
        _proposeZeroDeficitSettlement(id);

        // cancel
        vm.prank(admin);
        treasury.cancelSettlement(id);

        assertEq(
            uint256(treasury.getSettlementStatus(id)),
            uint256(MoaArcTreasury.SettlementStatus.None)
        );

        // releaseBudget should now succeed
        uint256 tripBalBefore = treasury.tripBalance(id);
        vm.prank(admin);
        treasury.releaseBudget(id, alice, 50e6, "post-cancel release");
        assertEq(treasury.tripBalance(id), tripBalBefore - 50e6);
        assertEq(treasury.allocatedBudget(id, alice), 50e6);
    }

    // =========================================================================
    // 9. canCancelSettlement view
    // =========================================================================

    function test_CanCancelSettlement_TrueWhenProposed() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);
        _proposeZeroDeficitSettlement(id);

        assertTrue(treasury.canCancelSettlement(id));
    }

    function test_CanCancelSettlement_FalseWhenNone() public {
        uint256 id = _createDefaultTrip();
        assertFalse(treasury.canCancelSettlement(id));
    }

    function test_CanCancelSettlement_FalseWhenDeficitPaying() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        address[] memory members = new address[](3);
        uint256[] memory refunds = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = 950e6; refunds[1] = 0; refunds[2] = 0;
        deficits[0] = 0; deficits[1] = 50e6; deficits[2] = 0;
        vm.prank(admin);
        treasury.proposeFinalSettlement(id, members, refunds, deficits);

        vm.startPrank(alice);
        usdc.approve(address(treasury), 50e6);
        treasury.payDeficit(id, 50e6);
        vm.stopPrank();

        assertFalse(treasury.canCancelSettlement(id));
    }

    function test_CanCancelSettlement_FalseWhenClaimStarted() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);
        (, , , bytes32 h) = _proposeZeroDeficitSettlement(id);
        _approveAll(id, h);

        vm.prank(admin);
        treasury.claimRefund(id);

        assertFalse(treasury.canCancelSettlement(id));
    }

    function test_CanCancelSettlement_FalseAfterCancel() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);
        _proposeZeroDeficitSettlement(id);

        vm.prank(admin);
        treasury.cancelSettlement(id);

        assertFalse(treasury.canCancelSettlement(id));
    }

    // =========================================================================
    // 10. Full settlement flow: createTrip → deposit → proposeFinalSettlement
    //     → all approve → claimRefund
    // =========================================================================

    function test_FullSettlementFlow() public {
        // ── createTrip ────────────────────────────────────────────────────────
        address[] memory parts = new address[](2);
        parts[0] = alice;
        parts[1] = bob;
        vm.prank(admin);
        uint256 id = treasury.createTrip("Tokyo 2025", parts, TARGET_BUDGET);
        assertEq(id, 1);
        assertTrue(treasury.isParticipant(id, admin));
        assertTrue(treasury.isParticipant(id, alice));
        assertTrue(treasury.isParticipant(id, bob));

        // ── deposit ───────────────────────────────────────────────────────────
        _depositAll(id);
        assertEq(treasury.tripBalance(id), 900e6);
        assertEq(treasury.depositedAmount(id, admin), DEPOSIT_AMOUNT);
        assertEq(treasury.depositedAmount(id, alice), DEPOSIT_AMOUNT);
        assertEq(treasury.depositedAmount(id, bob),   DEPOSIT_AMOUNT);

        // ── proposeFinalSettlement ────────────────────────────────────────────
        address[] memory members = new address[](3);
        uint256[] memory refunds = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        // admin: 300 refund, alice: 300 refund, bob: 300 refund, no deficits
        refunds[0] = 300e6; refunds[1] = 300e6; refunds[2] = 300e6;
        deficits[0] = 0; deficits[1] = 0; deficits[2] = 0;

        uint256 version = treasury.getSettlementVersion(id) + 1;
        bytes32 h = keccak256(abi.encode(id, version, members, refunds, deficits));

        vm.prank(admin);
        vm.expectEmit(true, true, false, false, address(treasury));
        emit MoaArcTreasury.SettlementProposed(id, h, members, refunds, deficits);
        treasury.proposeFinalSettlement(id, members, refunds, deficits);

        assertEq(
            uint256(treasury.getSettlementStatus(id)),
            uint256(MoaArcTreasury.SettlementStatus.Proposed)
        );
        assertTrue(treasury.canCancelSettlement(id));

        // ── all approve ───────────────────────────────────────────────────────
        vm.prank(admin);
        treasury.approveFinalSettlement(id, h);
        vm.prank(alice);
        treasury.approveFinalSettlement(id, h);
        vm.prank(bob);
        treasury.approveFinalSettlement(id, h);

        assertTrue(treasury.isAllApproved(id));
        assertTrue(treasury.isAllDeficitPaid(id)); // zero deficits

        // ── claimRefund ───────────────────────────────────────────────────────
        uint256 adminBalBefore = usdc.balanceOf(admin);
        uint256 aliceBalBefore = usdc.balanceOf(alice);
        uint256 bobBalBefore   = usdc.balanceOf(bob);

        vm.prank(admin);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArcTreasury.RefundClaimed(id, admin, 300e6);
        treasury.claimRefund(id);

        vm.prank(alice);
        treasury.claimRefund(id);

        vm.prank(bob);
        vm.expectEmit(true, true, false, false, address(treasury));
        emit MoaArcTreasury.TripCompleted(id);
        treasury.claimRefund(id);

        // all three got their refund
        assertEq(usdc.balanceOf(admin), adminBalBefore + 300e6);
        assertEq(usdc.balanceOf(alice), aliceBalBefore + 300e6);
        assertEq(usdc.balanceOf(bob),   bobBalBefore   + 300e6);

        // tripBalance drained to zero
        assertEq(treasury.tripBalance(id), 0);

        // status Completed, trip locked
        assertEq(
            uint256(treasury.getSettlementStatus(id)),
            uint256(MoaArcTreasury.SettlementStatus.Completed)
        );
        MoaArcTreasury.Trip memory t = treasury.getTrip(id);
        assertTrue(t.locked);

        // double-claim reverts — contract checks trip.locked before refundClaimed,
        // so the trip being locked (Completed) produces TripLocked, not AlreadyClaimed.
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MoaArcTreasury.TripLocked.selector, id));
        treasury.claimRefund(id);
    }

    // =========================================================================
    // 11. Per-trip isolation (two concurrent trips)
    // =========================================================================

    function test_TwoTrips_Isolation() public {
        // Trip 1: admin + alice
        address[] memory parts1 = new address[](1);
        parts1[0] = alice;
        vm.prank(admin);
        uint256 trip1 = treasury.createTrip("Trip A", parts1, 200e6);

        // Trip 2: bob + carol
        address[] memory parts2 = new address[](1);
        parts2[0] = carol;
        vm.prank(bob);
        uint256 trip2 = treasury.createTrip("Trip B", parts2, 200e6);

        assertEq(trip1, 1);
        assertEq(trip2, 2);

        // Deposit into trip 1
        vm.startPrank(admin);
        usdc.approve(address(treasury), 100e6);
        treasury.deposit(trip1, 100e6);
        vm.stopPrank();

        // Deposit into trip 2
        vm.startPrank(bob);
        usdc.approve(address(treasury), 200e6);
        treasury.deposit(trip2, 200e6);
        vm.stopPrank();

        // Trip balances are independent
        assertEq(treasury.tripBalance(trip1), 100e6);
        assertEq(treasury.tripBalance(trip2), 200e6);

        // Deposits don't cross-contaminate
        assertEq(treasury.depositedAmount(trip1, admin), 100e6);
        assertEq(treasury.depositedAmount(trip1, bob),   0);
        assertEq(treasury.depositedAmount(trip2, bob),   200e6);
        assertEq(treasury.depositedAmount(trip2, admin), 0);

        // Participants isolated
        assertTrue(treasury.isParticipant(trip1, admin));
        assertTrue(treasury.isParticipant(trip1, alice));
        assertFalse(treasury.isParticipant(trip1, bob));
        assertFalse(treasury.isParticipant(trip1, carol));

        assertTrue(treasury.isParticipant(trip2, bob));
        assertTrue(treasury.isParticipant(trip2, carol));
        assertFalse(treasury.isParticipant(trip2, admin));
        assertFalse(treasury.isParticipant(trip2, alice));

        // Settlement on trip1 doesn't affect trip2
        address[] memory members1 = new address[](2);
        uint256[] memory refunds1 = new uint256[](2);
        uint256[] memory deficits1 = new uint256[](2);
        members1[0] = admin; members1[1] = alice;
        refunds1[0] = 100e6; refunds1[1] = 0;
        vm.prank(admin);
        treasury.proposeFinalSettlement(trip1, members1, refunds1, deficits1);

        assertEq(
            uint256(treasury.getSettlementStatus(trip1)),
            uint256(MoaArcTreasury.SettlementStatus.Proposed)
        );
        assertEq(
            uint256(treasury.getSettlementStatus(trip2)),
            uint256(MoaArcTreasury.SettlementStatus.None)
        );
    }

    // =========================================================================
    // 12. Invariant: tripBalance tracks deposits/releases/returns correctly
    // =========================================================================

    function test_TripBalance_TrackDepositsReleasesReturns() public {
        uint256 id = _createDefaultTrip();

        // initial balance
        assertEq(treasury.tripBalance(id), 0);

        // deposit 300e6 from admin
        vm.startPrank(admin);
        usdc.approve(address(treasury), 300e6);
        treasury.deposit(id, 300e6);
        vm.stopPrank();
        assertEq(treasury.tripBalance(id), 300e6);

        // deposit 200e6 from alice
        vm.startPrank(alice);
        usdc.approve(address(treasury), 200e6);
        treasury.deposit(id, 200e6);
        vm.stopPrank();
        assertEq(treasury.tripBalance(id), 500e6);

        // release 150e6 to alice
        vm.prank(admin);
        treasury.releaseBudget(id, alice, 150e6, "hotel");
        assertEq(treasury.tripBalance(id), 350e6);
        assertEq(treasury.allocatedBudget(id, alice), 150e6);

        // alice returns 100e6 of that budget
        vm.startPrank(alice);
        usdc.approve(address(treasury), 100e6);
        treasury.returnUnusedBudget(id, 100e6);
        vm.stopPrank();
        assertEq(treasury.tripBalance(id), 450e6);
        assertEq(treasury.allocatedBudget(id, alice), 50e6);

        // Check USDC balance of contract matches tripBalance
        assertEq(usdc.balanceOf(address(treasury)), 450e6);
    }

    // =========================================================================
    // Additional coverage: createTrip edge cases
    // =========================================================================

    function test_CreateTrip_HappyPath() public {
        address[] memory parts = new address[](1);
        parts[0] = alice;
        vm.prank(admin);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArcTreasury.TripCreated(1, admin, "Rome", 500e6);
        uint256 id = treasury.createTrip("Rome", parts, 500e6);
        assertEq(id, 1);
        assertEq(treasury.tripCount(), 1);
        MoaArcTreasury.Trip memory t = treasury.getTrip(id);
        assertEq(t.name, "Rome");
        assertEq(t.admin, admin);
        assertEq(t.targetBudget, 500e6);
        assertTrue(t.exists);
    }

    function test_CreateTrip_RevertsZeroParticipantAddress() public {
        address[] memory parts = new address[](1);
        parts[0] = address(0);
        vm.prank(admin);
        vm.expectRevert(MoaArcTreasury.ZeroAddress.selector);
        treasury.createTrip("Bad", parts, 100e6);
    }

    function test_CreateTrip_RevertsAlreadyParticipant() public {
        address[] memory parts = new address[](2);
        parts[0] = alice;
        parts[1] = alice; // duplicate
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(MoaArcTreasury.AlreadyParticipant.selector, alice)
        );
        treasury.createTrip("Dup", parts, 100e6);
    }

    function test_CreateTrip_RevertsTooManyParticipants() public {
        // MAX_PARTICIPANTS = 50; we provide 50 extras + admin = 51 total
        address[] memory parts = new address[](50);
        for (uint256 i = 0; i < 50; i++) {
            parts[i] = makeAddr(string(abi.encodePacked("p", i)));
        }
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(MoaArcTreasury.TooManyParticipants.selector, 50, 51)
        );
        treasury.createTrip("BigTrip", parts, 1e6);
    }

    // =========================================================================
    // Additional coverage: deposit edge cases
    // =========================================================================

    function test_Deposit_HappyPath() public {
        uint256 id = _createDefaultTrip();
        vm.startPrank(alice);
        usdc.approve(address(treasury), 500e6);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArcTreasury.Deposited(id, alice, 500e6);
        treasury.deposit(id, 500e6);
        vm.stopPrank();

        assertEq(treasury.depositedAmount(id, alice), 500e6);
        assertEq(treasury.tripBalance(id), 500e6);
    }

    function test_Deposit_RevertsZeroAmount() public {
        uint256 id = _createDefaultTrip();
        vm.startPrank(alice);
        usdc.approve(address(treasury), 1);
        vm.expectRevert(MoaArcTreasury.InvalidAmount.selector);
        treasury.deposit(id, 0);
        vm.stopPrank();
    }

    function test_Deposit_RevertsNonParticipant() public {
        uint256 id = _createDefaultTrip();
        vm.startPrank(outside);
        usdc.approve(address(treasury), 100e6);
        vm.expectRevert(abi.encodeWithSelector(MoaArcTreasury.NotParticipant.selector, id));
        treasury.deposit(id, 100e6);
        vm.stopPrank();
    }

    function test_Deposit_RevertsTripNotFound() public {
        vm.startPrank(admin);
        usdc.approve(address(treasury), 100e6);
        vm.expectRevert(abi.encodeWithSelector(MoaArcTreasury.TripNotFound.selector, 99));
        treasury.deposit(99, 100e6);
        vm.stopPrank();
    }

    // =========================================================================
    // Additional coverage: returnUnusedBudget
    // =========================================================================

    function test_ReturnUnusedBudget_HappyPath() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        vm.prank(admin);
        treasury.releaseBudget(id, alice, 200e6, "flights");

        uint256 aliceBalBefore = usdc.balanceOf(alice);
        uint256 tripBalBefore  = treasury.tripBalance(id);

        vm.startPrank(alice);
        usdc.approve(address(treasury), 100e6);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArcTreasury.BudgetReturned(id, alice, 100e6);
        treasury.returnUnusedBudget(id, 100e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice), aliceBalBefore - 100e6);
        assertEq(treasury.tripBalance(id), tripBalBefore + 100e6);
        assertEq(treasury.allocatedBudget(id, alice), 100e6);
    }

    function test_ReturnUnusedBudget_RevertsExceedsAllocated() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        vm.prank(admin);
        treasury.releaseBudget(id, alice, 50e6, "partial");

        vm.startPrank(alice);
        usdc.approve(address(treasury), 100e6);
        vm.expectRevert(
            abi.encodeWithSelector(MoaArcTreasury.ExceedsAllocated.selector, 50e6, 100e6)
        );
        treasury.returnUnusedBudget(id, 100e6);
        vm.stopPrank();
    }

    // =========================================================================
    // Additional coverage: proposeFinalSettlement edge cases
    // =========================================================================

    function test_ProposeFinalSettlement_RevertsArrayLengthMismatch() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        address[] memory members = new address[](3);
        uint256[] memory refunds = new uint256[](2); // wrong length
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;

        vm.prank(admin);
        vm.expectRevert(MoaArcTreasury.ArrayLengthMismatch.selector);
        treasury.proposeFinalSettlement(id, members, refunds, deficits);
    }

    function test_ProposeFinalSettlement_RevertsNonAdmin() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        address[] memory members = new address[](3);
        uint256[] memory refunds = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = 900e6;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MoaArcTreasury.NotAdmin.selector, id));
        treasury.proposeFinalSettlement(id, members, refunds, deficits);
    }

    function test_ProposeFinalSettlement_RevertsAlreadyInProgress() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        address[] memory members = new address[](3);
        uint256[] memory refunds = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = 950e6;
        deficits[1] = 50e6;

        vm.prank(admin);
        treasury.proposeFinalSettlement(id, members, refunds, deficits);

        // alice pays deficit → DeficitPaying
        vm.startPrank(alice);
        usdc.approve(address(treasury), 50e6);
        treasury.payDeficit(id, 50e6);
        vm.stopPrank();

        // attempt second propose → should fail
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.SettlementAlreadyInProgress.selector,
                MoaArcTreasury.SettlementStatus.DeficitPaying
            )
        );
        treasury.proposeFinalSettlement(id, members, refunds, deficits);
    }

    // =========================================================================
    // Additional coverage: approveFinalSettlement edge cases
    // =========================================================================

    function test_ApproveFinalSettlement_RevertsNoSettlement() public {
        uint256 id = _createDefaultTrip();

        vm.prank(alice);
        vm.expectRevert(MoaArcTreasury.NoSettlementProposed.selector);
        treasury.approveFinalSettlement(id, bytes32(0));
    }

    function test_ApproveFinalSettlement_RevertsHashMismatch() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);
        _proposeZeroDeficitSettlement(id);

        // Retrieve the real hash stored in the trip so we can pass the wrong one
        bytes32 realHash = treasury.getTrip(id).pendingSettlementHash;
        bytes32 wrongHash = bytes32(uint256(0xdead));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.InvalidSettlementHash.selector,
                realHash,
                wrongHash
            )
        );
        treasury.approveFinalSettlement(id, wrongHash);
    }

    // =========================================================================
    // Additional coverage: claimRefund edge cases
    // =========================================================================

    function test_ClaimRefund_RevertsNotAllApproved() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);
        (, , , bytes32 h) = _proposeZeroDeficitSettlement(id);

        // Only admin approves
        vm.prank(admin);
        treasury.approveFinalSettlement(id, h);

        vm.prank(admin);
        vm.expectRevert(MoaArcTreasury.NotAllApproved.selector);
        treasury.claimRefund(id);
    }

    function test_ClaimRefund_RevertsNoSettlement() public {
        uint256 id = _createDefaultTrip();

        vm.prank(admin);
        vm.expectRevert(MoaArcTreasury.NoSettlementProposed.selector);
        treasury.claimRefund(id);
    }

    // =========================================================================
    // Additional coverage: payDeficit
    // =========================================================================

    function test_PayDeficit_HappyPath() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        address[] memory members = new address[](3);
        uint256[] memory refunds = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = 950e6; refunds[1] = 0; refunds[2] = 0;
        deficits[0] = 0; deficits[1] = 50e6; deficits[2] = 0;

        vm.prank(admin);
        treasury.proposeFinalSettlement(id, members, refunds, deficits);

        uint256 tripBalBefore = treasury.tripBalance(id);
        vm.startPrank(alice);
        usdc.approve(address(treasury), 50e6);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArcTreasury.DeficitPaid(id, alice, 50e6);
        treasury.payDeficit(id, 50e6);
        vm.stopPrank();

        assertEq(treasury.paidDeficit(id, alice), 50e6);
        assertEq(treasury.tripBalance(id), tripBalBefore + 50e6);
        assertEq(
            uint256(treasury.getSettlementStatus(id)),
            uint256(MoaArcTreasury.SettlementStatus.DeficitPaying)
        );
    }

    function test_PayDeficit_RevertsExceedsRequired() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        address[] memory members = new address[](3);
        uint256[] memory refunds = new uint256[](3);
        uint256[] memory deficits = new uint256[](3);
        members[0] = admin; members[1] = alice; members[2] = bob;
        refunds[0] = 950e6;
        deficits[1] = 50e6;

        vm.prank(admin);
        treasury.proposeFinalSettlement(id, members, refunds, deficits);

        vm.startPrank(alice);
        usdc.approve(address(treasury), 100e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.ExceedsRequiredDeficit.selector,
                50e6,
                0,
                100e6
            )
        );
        treasury.payDeficit(id, 100e6);
        vm.stopPrank();
    }

    // =========================================================================
    // Additional coverage: getContractBalance
    // =========================================================================

    function test_GetContractBalance() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        assertEq(treasury.getContractBalance(), 900e6);
        assertEq(treasury.getContractBalance(), usdc.balanceOf(address(treasury)));
    }

    // =========================================================================
    // Additional coverage: constructor reverts zero address
    // =========================================================================

    function test_Constructor_RevertsZeroAddress() public {
        vm.expectRevert(MoaArcTreasury.ZeroAddress.selector);
        new MoaArcTreasury(address(0));
    }

    // =========================================================================
    // Additional coverage: recordActualSpend
    // =========================================================================

    function test_RecordActualSpend_HappyPath() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        vm.prank(admin);
        treasury.releaseBudget(id, alice, 200e6, "misc");

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArcTreasury.ActualSpendRecorded(id, alice, 150e6, "dinner");
        treasury.recordActualSpend(id, 150e6, "dinner");

        assertEq(treasury.getSpentFromBudget(id, alice), 150e6);
    }

    function test_RecordActualSpend_RevertsExceedsAllocated() public {
        uint256 id = _createDefaultTrip();
        _depositAll(id);

        vm.prank(admin);
        treasury.releaseBudget(id, alice, 50e6, "misc");

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoaArcTreasury.SpendAmountExceedsAllocated.selector,
                50e6,
                0,
                100e6
            )
        );
        treasury.recordActualSpend(id, 100e6, "over budget");
    }

    // =========================================================================
    // Additional coverage: recordPersonalPrepaid
    // =========================================================================

    function test_RecordPersonalPrepaid_HappyPath() public {
        uint256 id = _createDefaultTrip();

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit MoaArcTreasury.PersonalPrepaidRecorded(id, alice, 200e6, "flight");
        treasury.recordPersonalPrepaid(id, 200e6, "flight");

        assertEq(treasury.getPersonalPrepaid(id, alice), 200e6);
    }

    function test_RecordPersonalPrepaid_RevertsNonParticipant() public {
        uint256 id = _createDefaultTrip();

        vm.prank(outside);
        vm.expectRevert(abi.encodeWithSelector(MoaArcTreasury.NotParticipant.selector, id));
        treasury.recordPersonalPrepaid(id, 100e6, "ghost");
    }

    // =========================================================================
    // Fuzz: releaseBudget amounts
    // =========================================================================

    function testFuzz_ReleaseBudget_AmountInRange(uint256 amount) public {
        uint256 id = _createDefaultTrip();
        _depositAll(id); // 900e6 total in trip
        amount = bound(amount, 1, 900e6);

        uint256 tripBalBefore  = treasury.tripBalance(id);
        uint256 aliceBalBefore = usdc.balanceOf(alice);

        vm.prank(admin);
        treasury.releaseBudget(id, alice, amount, "fuzz");

        assertEq(treasury.tripBalance(id),            tripBalBefore  - amount);
        assertEq(usdc.balanceOf(alice),               aliceBalBefore + amount);
        assertEq(treasury.allocatedBudget(id, alice), amount);
    }

    // =========================================================================
    // Fuzz: deposit amount tracking
    // =========================================================================

    function testFuzz_Deposit_TracksCorrectly(uint256 amount) public {
        amount = bound(amount, 1, MINT_AMOUNT);
        uint256 id = _createDefaultTrip();

        vm.startPrank(alice);
        usdc.approve(address(treasury), amount);
        treasury.deposit(id, amount);
        vm.stopPrank();

        assertEq(treasury.depositedAmount(id, alice), amount);
        assertEq(treasury.tripBalance(id),            amount);
        assertEq(usdc.balanceOf(address(treasury)),   amount);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant test contract (separate from unit tests)
// ─────────────────────────────────────────────────────────────────────────────
contract MoaArcTreasuryInvariantTest is Test {
    TreasuryHandler internal handler;
    MoaArcTreasury  internal treasury;
    MockERC20        internal usdc;

    function setUp() public {
        usdc     = new MockERC20("Mock USDC", "mUSDC", 6);
        treasury = new MoaArcTreasury(address(usdc));
        handler  = new TreasuryHandler(treasury, usdc);
        targetContract(address(handler));
    }

    /// tripBalance always equals the ghost tracker that mirrors each deposit/release/return
    function invariant_TripBalanceAccounting() public view {
        uint256 tripId = handler.tripId();
        assertEq(treasury.tripBalance(tripId), handler.ghostBalance());
    }

    /// USDC held by contract >= sum of all tripBalances tracked by handler
    function invariant_ContractUsdcCoversBalance() public view {
        uint256 tripId   = handler.tripId();
        uint256 tripBal  = treasury.tripBalance(tripId);
        uint256 contract_ = usdc.balanceOf(address(treasury));
        assertGe(contract_, tripBal);
    }
}
